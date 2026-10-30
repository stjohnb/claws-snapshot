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
  FLEET_GRAFANA_URL: "https://grafana.home.example",
  // Empty: grafana-jwt.ts generates an in-memory key on first mint.
  GRAFANA_JWT_SIGNING_KEY: "",
  writeConfig: async () => {},
  FORGEJO_TOKEN: "",
  FORGEJO_READ_TOKEN: "",
  FORGEJO_ADMIN_TOKEN: "",
  FORGEJO_BASE_URL: "https://git.example.test",
  FORGEJO_REPOS: [] as string[],
  OPENROUTER_API_KEY: "",
  ANTHROPIC_API_KEY: "",
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
  PROD_CLUSTER_TAILNET_HOST: "prod-cluster-11",
  PROD_DATA_TAILNET_HOST: "prod-data-14",
  // Stand-in for config.ts's resolveLanHost with documentation-range addresses.
  resolveLanHost: <T extends { host: string; user?: string }>(target: T): T => {
    const aliases: Record<string, { host: string; user: string }> = {
      "brendans-macbook-pro": { host: "203.0.113.1", user: "brendan" },
      "brendans-macbook-pro-3": { host: "203.0.113.2", user: "brendanstjohn" },
    };
    const alias = aliases[target.host.toLowerCase().replace(/\.local\.?$/, "")];
    return alias ? { ...target, host: alias.host, user: target.user ?? alias.user } : target;
  },
  getMacRunnerRepos: (): readonly string[] => ["Owner/MacRepo"],
  MAC_RUNNERS: [
    { name: "Brendans-MacBook-Pro", host: "brendans-macbook-pro.local", labels: ["macos", "tempo"] },
    { name: "Brendans-MacBook-Pro-3", host: "brendans-macbook-pro-3.local", user: "brendanstjohn", labels: ["macos", "xcode26"], enabled: false },
  ] as MockMacRunner[],
}));

const DEFAULT_TEST_MAC_RUNNERS = mockConfig.MAC_RUNNERS;

vi.mock("./config.js", () => mockConfig);

import { setClaudeAccounts } from "./claude-accounts.js";

/** Seed the Claude accounts cache (database state) with these tokens. */
function setClaudeTokens(tokens: { primary?: string; second?: string }): void {
  setClaudeAccounts([{ id: "primary", label: "primary", token: tokens.primary ?? null }, { id: "second", label: "second", token: tokens.second ?? null }]);
}

import {
  buildCapabilityEnvArgs,
  buildCapabilityPrompt,
  buildRequestableCapabilityPrompt,
  classifyLiveGrants,
  FIXED_AT_LAUNCH_REASON,
  browserUnsupportedReason,
  type LiveGrantTarget,
  resolveCapabilityEnv,
  capabilityEnvKeys,
  validCapabilityIds,
  availableCapabilities,
  isCapabilityAvailable,
  REPO_CAPABILITY_DEFAULTS,
  suggestedCapabilitiesForRepo,
  suggestedReposForCapability,
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
  INFRA_MERGE_CAPABILITY_ID,
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
const MCP_TIMEOUT_ARG = "MCP_TOOL_TIMEOUT=3900000";
const assignments = (args: string[]) => args.filter((a) => a.includes("=") && a !== MCP_TIMEOUT_ARG);

// Live-grant targets: a Claude agent session, and a codex one (which cannot use browser).
const CLAUDE: LiveGrantTarget = { provider: "claude", mode: "worktree-claude" };
const CODEX: LiveGrantTarget = { provider: "codex", mode: "worktree-claude" };

describe("capabilities", () => {
  beforeEach(() => {
    mockConfig.HOME_ASSISTANT_BASE_URL = "https://ha.example";
    mockConfig.HOME_ASSISTANT_TOKEN = "ha-token";
    mockConfig.FORGEJO_TOKEN = "";
    mockConfig.FORGEJO_READ_TOKEN = "";
    mockConfig.FORGEJO_ADMIN_TOKEN = "";
    mockConfig.FORGEJO_BASE_URL = "https://git.example.test";
    mockConfig.FORGEJO_REPOS = [];
    mockConfig.OPENROUTER_API_KEY = "";
    mockConfig.ANTHROPIC_API_KEY = "";
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
    // Above claws_wait_for_change's one-hour maximum.
    expect(Number(MCP_TIMEOUT_ARG.split("=")[1])).toBeGreaterThan(3600_000);
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
    expect(ids).not.toContain("ssh:proxmox");
    // 3 hardcoded aliases + 2 prod nodes + the one enabled Mac from
    // DEFAULT_TEST_MAC_RUNNERS (the second is `enabled: false`).
    expect(ids.filter((id) => id.startsWith("ssh:")).length).toBe(6);
  });

  it("production cluster nodes are ssh-group capabilities with a tailnet-jump description", () => {
    for (const [host, tailnet] of [["prod-cluster", "prod-cluster-11"], ["prod-data", "prod-data-14"]]) {
      const cap = availableCapabilities().find((c) => c.id === `ssh:${host}`)!;
      expect(cap.group).toBe("ssh");
      expect(cap.description).not.toContain("=");
      expect(cap.description).toContain(`tailscale ssh root@${tailnet} -- COMMAND`);
      expect(cap.description).toContain("k3s kubectl");
      expect(cap.description).toContain(`echo <base64 of the script> | ssh nas 'base64 -d | tailscale ssh root@${tailnet} -- bash -s'`);
      expect(cap.description).toContain("runs on nas");
      expect(cap.label).toContain(`SSH: ${host} (production`);
    }
  });

  it("production node commands use the configured tailnet host and keep the stable id", async () => {
    vi.resetModules();
    mockConfig.PROD_CLUSTER_TAILNET_HOST = "prod-cluster-12";
    try {
      const mod = await import("./capabilities.js");
      const cap = mod.availableCapabilities().find((c) => c.id === "ssh:prod-cluster")!;
      expect(cap.description).toContain("root@prod-cluster-12 -- COMMAND");
      expect(cap.description).not.toContain("root@prod-cluster-11");
    } finally {
      mockConfig.PROD_CLUSTER_TAILNET_HOST = "prod-cluster-11";
    }
  });

  it("SSH labels carry a role suffix", () => {
    const label = (id: string) => availableCapabilities().find((c) => c.id === id)!.label;
    expect(label("ssh:nas")).toBe("SSH: nas (NixOS NAS)");
    expect(label("ssh:brendans-macbook-pro")).toBe("SSH: Brendans-MacBook-Pro (macOS Actions runner)");
  });

  it("suggests prod and Mac SSH hosts for the relevant repos without pre-ticking them", () => {
    expect(suggestedCapabilitiesForRepo("St-John-Software/production-infra")).toEqual(["ssh:prod-cluster", "ssh:prod-data"]);
    expect(suggestedCapabilitiesForRepo("owner/macrepo")).toEqual(["ssh:brendans-macbook-pro"]);
    expect(suggestedCapabilitiesForRepo("Owner/Other")).toEqual([]);
    expect(suggestedReposForCapability("ssh:prod-data")).toContain("St-John-Software/namey");
    expect(suggestedReposForCapability("ssh:brendans-macbook-pro", ["Owner/MacRepo", "Owner/Other"])).toEqual(["Owner/MacRepo"]);
    for (const repo of ["St-John-Software/production-infra", "Owner/MacRepo"]) {
      const defaults = defaultCapabilitiesForRepo(repo);
      expect(defaults).not.toContain("ssh:prod-cluster");
      expect(defaults).not.toContain("ssh:brendans-macbook-pro");
    }
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

  it("ssh:k3s is renamed to ssh:thinkcentre and only the new id is offered", () => {
    expect(isCapabilityAvailable("ssh:k3s")).toBe(false);
    expect(availableCapabilities().map((c) => c.id)).not.toContain("ssh:k3s");
    expect(availableCapabilities().map((c) => c.id)).toContain("ssh:thinkcentre");
    expect(validCapabilityIds(["ssh:k3s", "ssh:thinkcentre"])).toEqual(["ssh:thinkcentre"]);
    const cap = CAPABILITIES.find((c) => c.id === "ssh:thinkcentre")!;
    expect(cap.description).toContain("192.168.0.251");
    expect(cap.description).not.toContain("=");
  });

  it("k3s kubectl guidance: server uses sudo, agents point at thinkcentre, prod unchanged", () => {
    const desc = (id: string) => CAPABILITIES.find((c) => c.id === id)!.description;
    expect(desc("ssh:thinkcentre")).toContain("sudo -n k3s kubectl");
    expect(desc("ssh:thinkcentre")).toContain("localhost:8080");
    for (const id of ["ssh:nas", "ssh:ryzen"]) {
      expect(desc(id)).toContain("localhost:8080");
      expect(desc(id)).toContain("ssh:thinkcentre");
      expect(desc(id)).not.toContain("sudo -n k3s kubectl)");
    }
    for (const id of ["ssh:thinkcentre", "ssh:nas", "ssh:ryzen"]) {
      expect(desc(id)).not.toContain("=");
    }
    for (const id of ["ssh:prod-cluster", "ssh:prod-data"]) {
      expect(desc(id)).toContain("k3s kubectl");
      expect(desc(id)).not.toContain("sudo -n");
    }
  });

  it("ssh:homeassistant is retired into ssh:thinkcentre", () => {
    expect(isCapabilityAvailable("ssh:homeassistant")).toBe(false);
    expect(availableCapabilities().map((c) => c.id)).not.toContain("ssh:homeassistant");
    expect(validCapabilityIds(["ssh:homeassistant"])).toEqual(["ssh:thinkcentre"]);
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


describe("infra-merge capability (#clw_01M54GYV05ZCZWKEEMAJTE9Q3X)", () => {
  it("is available with no credentials, in the infra group, and injects and strips nothing", () => {
    expect(isCapabilityAvailable(INFRA_MERGE_CAPABILITY_ID)).toBe(true);
    expect(availableCapabilities().map((c) => c.id)).toContain("infra-merge");
    const cap = CAPABILITIES.find((c) => c.id === INFRA_MERGE_CAPABILITY_ID)!;
    expect(capabilityGroup(cap)).toBe("infra");
    expect(cap.envKeys).toEqual([]);
    expect(resolveCapabilityEnv([INFRA_MERGE_CAPABILITY_ID]).vars).toEqual({});
    expect(assignments(buildCapabilityEnvArgs([INFRA_MERGE_CAPABILITY_ID], null))).toEqual([]);
  });

  it("is live-grantable to a running session and named in its prompt once granted", () => {
    expect(liveGrantableCapabilities([], "k8s-pod", CLAUDE).map((c) => c.id)).toContain("infra-merge");
    expect(liveGrantableCapabilities(["infra-merge"], "k8s-pod", CLAUDE).map((c) => c.id)).not.toContain("infra-merge");
    expect(buildCapabilityPrompt(["infra-merge"])).toContain("human merge");
  });

  it("is never remembered, defaulted, suggested or offered to headless planners", () => {
    expect(isRememberableCapability(INFRA_MERGE_CAPABILITY_ID)).toBe(false);
    for (const repo of ["St-John-Software/production-infra", "St-John-Software/claws", "St-John-Software/fleet-infra"]) {
      expect(defaultCapabilitiesForRepo(repo)).not.toContain("infra-merge");
      expect(suggestedCapabilitiesForRepo(repo)).not.toContain("infra-merge");
      expect(plannerCapabilitiesForRepo(repo)).not.toContain("infra-merge");
    }
    expect(withImplicitCapabilities([], ["St-John-Software/production-infra"])).not.toContain("infra-merge");
    expect(resolveHeadlessPlannerCapabilityAccess([INFRA_MERGE_CAPABILITY_ID])).toBeNull();
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
  ])("grants %s the fleet observability default", (repo) => {
    expect(plannerCapabilitiesForRepo(repo)).toEqual(["fleet-observability"]);
  });

  it("returns an independent copy of the default", () => {
    plannerCapabilitiesForRepo("St-John-Software/unknown").push("ssh:ryzen");
    expect(plannerCapabilitiesForRepo("St-John-Software/unknown")).toEqual(["fleet-observability"]);
  });

  it("looks up full repo names case-insensitively and returns an independent list", () => {
    const ids = plannerCapabilitiesForRepo("ST-JOHN-SOFTWARE/FLEET-INFRA");
    expect(ids).toEqual(["fleet-observability"]);
    ids.push("ssh:ryzen");
    expect(plannerCapabilitiesForRepo("St-John-Software/fleet-infra")).toEqual(["fleet-observability"]);
  });
});

describe("observability capabilities", () => {
  const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

  it("is always available, in the infra group, with nothing configured", () => {
    const ids = availableCapabilities().map((c) => c.id);
    expect(ids).toContain("prod-observability");
    expect(ids).toContain("fleet-observability");
    const cap = availableCapabilities().find((c) => c.id === "prod-observability");
    expect(cap && capabilityGroup(cap)).toBe("infra");
  });

  it("injects the URL and a fresh per-cluster Claws JWT when granted and strips them when not", () => {
    const { vars } = resolveCapabilityEnv(["prod-observability", "fleet-observability"]);
    expect(Object.keys(vars).sort()).toEqual([
      "CLAWS_FLEET_GRAFANA_TOKEN",
      "CLAWS_FLEET_GRAFANA_URL",
      "CLAWS_PROD_GRAFANA_TOKEN",
      "CLAWS_PROD_GRAFANA_URL",
    ]);
    expect(vars.CLAWS_PROD_GRAFANA_URL).toBe("https://grafana.example");
    expect(vars.CLAWS_FLEET_GRAFANA_URL).toBe("https://grafana.home.example");
    expect(vars.CLAWS_PROD_GRAFANA_TOKEN).toMatch(/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/);
    expect(vars.CLAWS_FLEET_GRAFANA_TOKEN).toMatch(/^eyJ/);
    expect(claims(vars.CLAWS_PROD_GRAFANA_TOKEN!).aud).toBe("grafana-prod");
    const fleet = claims(vars.CLAWS_FLEET_GRAFANA_TOKEN!);
    expect(fleet.aud).toBe("grafana-fleet");
    expect((fleet.exp as number) - (fleet.iat as number)).toBe(7 * 24 * 60 * 60);
    const none = resolveCapabilityEnv([]);
    expect(none.stripKeys).toContain("CLAWS_PROD_GRAFANA_TOKEN");
    expect(none.stripKeys).toContain("CLAWS_FLEET_GRAFANA_TOKEN");
  });

  it("describes the fleet Bearer route as taking a Claws-signed JWT", () => {
    const cap = CAPABILITIES.find((c) => c.id === "fleet-observability");
    expect(cap?.description).toContain("Claws-signed JWT starting with eyJ");
    expect(cap?.description).not.toContain("glsa_");
    expect(cap?.description).not.toContain("not live yet");
  });

  it("adds a read-only sentence for headless planners and never leaks the token", () => {
    const access = resolveHeadlessPlannerCapabilityAccess(["prod-observability"]);
    expect(access?.grantedIds).toEqual(["prod-observability"]);
    expect(access?.env.CLAWS_PROD_GRAFANA_TOKEN).toMatch(/^eyJ/);
    expect(access?.prompt).toContain("Bearer");
    expect(access?.prompt).toContain("read-only query endpoints");
    expect(access?.prompt).toContain("A Loki, Prometheus or alert check these capabilities can run is not an operator step");
    expect(access?.prompt).not.toContain(access?.env.CLAWS_PROD_GRAFANA_TOKEN);
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

  it("withImplicitCapabilities grants forgejo for any repo, discovered or not", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    mockConfig.FORGEJO_REPOS = [];
    expect(withImplicitCapabilities([], ["st-john-software/PERUDO"])).toContain("forgejo");
    expect(withImplicitCapabilities([], ["owner/other"])).toContain("forgejo");
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

  it("withImplicitCapabilities grants only cross-repo for a session with no repo", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    expect(withImplicitCapabilities([], [null])).toEqual(["cross-repo"]);
    expect(withImplicitCapabilities([], [])).toEqual(["cross-repo"]);
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
    expect(access.prompt).toContain("$CLAWS_FORGEJO_BASE_URL/api/v1/repos/OWNER/NAME/contents/DIR");
    expect(access.prompt).toContain("`.../repos/OWNER/NAME/pulls`, `.../pulls/N` and `.../pulls/N/reviews`");
    expect(access.prompt).not.toMatch(/\bgh\b/);
    expect(access.prompt).not.toContain("GitHub");
    expect(access.prompt).toContain("$CLAWS_FORGEJO_READ_TOKEN");
    expect(access.prompt).not.toContain("read-secret");
  });

  it("points cross-repo filing at claws_create_issue, with no GitHub fallback", () => {
    const access = resolveHeadlessCrossRepoAccess()!;
    expect(access.prompt).toContain("claws_create_issue");
    expect(access.prompt).not.toContain("gh issue create");
    expect(access.prompt).toContain("every repo");
    expect(access.prompt).not.toContain("File a companion issue");
  });

  it("gives no headless cross-repo access when no read token is configured", () => {
    mockConfig.FORGEJO_READ_TOKEN = "";
    expect(resolveHeadlessCrossRepoAccess()).toBeNull();
  });

  it("is not live-grantable", () => {
    expect(liveGrantableCapabilities([], "k8s-pod", CLAUDE).map((c) => c.id)).not.toContain("cross-repo");
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
    expect(REPO_CAPABILITY_DEFAULTS["St-John-Software/fleet-infra"]).toEqual(["fleet-observability", "ssh:thinkcentre", "ssh:ryzen", "ssh:nas"]);
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
    expect(defaultCapabilitiesForRepo("St-John-Software/home-assistant-config")).toEqual(["ssh:thinkcentre"]);
  });

  it("includes home-assistant once HOME_ASSISTANT_TOKEN is configured", () => {
    mockConfig.HOME_ASSISTANT_TOKEN = "tok";
    expect(defaultCapabilitiesForRepo("St-John-Software/home-assistant-config")).toEqual([
      "home-assistant",
      "ssh:thinkcentre",
    ]);
  });
});

describe("github-auth is retired", () => {
  beforeEach(() => {
    mockConfig.GITHUB_APP_ID = 123;
  });

  afterEach(() => {
    mockConfig.GITHUB_APP_ID = 0;
  });

  it("is not in the registry, even with a GitHub App configured", () => {
    expect(CAPABILITIES.some((c) => c.id === "github-auth")).toBe(false);
    expect(availableCapabilities().some((c) => c.id === "github-auth")).toBe(false);
    expect(CAPABILITIES.some((c) => /\bgh\b \+ git|GitHub \(gh/.test(c.label))).toBe(false);
  });

  it("is never a default: not for a repo, a repo-zsh shell or an agent login", () => {
    expect(defaultCapabilitiesForRepo("St-John-Software/astro")).toEqual([]);
    expect(defaultCapabilitiesForRepo("St-John-Software/nixos-config")).toEqual(["ssh:nas", "ssh:ryzen"]);
    expect(defaultProviderAuthCapabilities("claude", "repo-zsh")).not.toContain("github-auth");
    expect(defaultProviderAuthCapabilities("claude", "worktree-claude")).not.toContain("github-auth");
  });

  it("is never granted implicitly, and a stored grant naming it drops out", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    try {
      expect(withImplicitCapabilities([], ["St-John-Software/astro"])).not.toContain("github-auth");
      expect(withImplicitCapabilities(["github-auth"], ["St-John-Software/astro"])).toEqual(["cross-repo", "forgejo"]);
      expect(validCapabilityIds(["github-auth", "home-assistant"])).not.toContain("github-auth");
    } finally {
      mockConfig.FORGEJO_TOKEN = "";
    }
  });

  it("reposForCapability('github-auth') is empty", () => {
    expect(reposForCapability("github-auth")).toEqual([]);
  });
});

describe("provider-auth capabilities (#3026)", () => {
  const PROVIDER_AUTH = ["claude-auth", "codex-auth", "openrouter-auth", "anthropic-api-auth", "pi-auth"];
  let codexHome: string;
  const savedEnv = { codexHome: process.env["CODEX_HOME"] };

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "claws-codex-home-"));
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    process.env["CODEX_HOME"] = codexHome;
    setClaudeTokens({ primary: "sk-ant-oat01-test" });
    mockConfig.OPENROUTER_API_KEY = "or-key";
    mockConfig.ANTHROPIC_API_KEY = "sk-ant-api";
    mockConfig.GITHUB_APP_ID = 123;
    mockConfig.GITHUB_OWNER_APP_CREDENTIALS = {};
    mockConfig.HOME_ASSISTANT_TOKEN = "ha-token";
  });

  afterEach(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
    setClaudeTokens({});
    if (savedEnv.codexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = savedEnv.codexHome;
  });

  it("are available when their source credential exists", () => {
    expect(validCapabilityIds(PROVIDER_AUTH)).toEqual(PROVIDER_AUTH);
  });

  it("drop out when their source credential is missing", () => {
    setClaudeTokens({});
    fs.rmSync(path.join(codexHome, "auth.json"));
    mockConfig.OPENROUTER_API_KEY = "";
    mockConfig.ANTHROPIC_API_KEY = "";
    expect(validCapabilityIds(PROVIDER_AUTH)).toEqual([]);
  });

  it("offers anthropic-api-auth only when the Anthropic API key is set, and never counts it as a pi credential", () => {
    mockConfig.ANTHROPIC_API_KEY = "";
    expect(isCapabilityAvailable("anthropic-api-auth")).toBe(false);
    mockConfig.ANTHROPIC_API_KEY = "sk-ant-api";
    expect(isCapabilityAvailable("anthropic-api-auth")).toBe(true);
    setClaudeTokens({});
    mockConfig.OPENROUTER_API_KEY = "";
    expect(isCapabilityAvailable("pi-auth")).toBe(false);
  });

  it("offers claude-auth when only a non-first account has a token", () => {
    setClaudeTokens({});
    expect(isCapabilityAvailable("claude-auth")).toBe(false);
    setClaudeTokens({ second: "sk-ant-oat01-second" });
    expect(isCapabilityAvailable("claude-auth")).toBe(true);
  });

  it("offers pi-auth when any one pi credential source exists", () => {
    setClaudeTokens({});
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
    expect(CAPABILITIES.find((c) => c.id === "anthropic-api-auth")?.provider).toBe("opencode");
    expect(CAPABILITIES.find((c) => c.id === "pi-auth")?.provider).toBe("pi");
    expect(buildCapabilityPrompt(["claude-auth"])).toContain("Claude login");
  });

  it.each([
    ["claude", "worktree-claude", ["claude-auth"]],
    ["claude", "home-claude", ["claude-auth"]],
    ["codex", "repo-claude", ["codex-auth"]],
    ["opencode", "worktree-claude", ["openrouter-auth", "anthropic-api-auth"]],
    ["pi", "repo-claude", ["pi-auth"]],
    ["claude", "multi-worktree-claude", ["claude-auth"]],
    ["claude", "repo-zsh", []],
    ["codex", "repo-zsh", []],
  ] as const)("defaultProviderAuthCapabilities(%s, %s) → %j", (provider, mode, expected) => {
    expect(defaultProviderAuthCapabilities(provider, mode)).toEqual(expected);
  });

  it("isAgentLoginCapability is true only for agent logins, not repo capabilities", () => {
    expect(isAgentLoginCapability("claude-auth")).toBe(true);
    expect(isAgentLoginCapability("codex-auth")).toBe(true);
    expect(isAgentLoginCapability("openrouter-auth")).toBe(true);
    expect(isAgentLoginCapability("pi-auth")).toBe(true);
    expect(isAgentLoginCapability("home-assistant")).toBe(false);
    expect(isAgentLoginCapability("no-such-capability")).toBe(false);
  });

  it("isRememberableCapability is false for agent logins and cross-repo, true for forgejo/repo capabilities", () => {
    expect(isRememberableCapability("claude-auth")).toBe(false);
    expect(isRememberableCapability(CROSS_REPO_CAPABILITY_ID)).toBe(false);
    expect(isRememberableCapability(FORGEJO_CAPABILITY_ID)).toBe(true);
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
    expect(resolveHeadlessForgejoAccess()).toBeNull();
  });

  it("returns the capability's resolved env", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    expect(resolveHeadlessForgejoAccess()!.env).toEqual(capability().resolve());
  });

  it("uses the capability description verbatim", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    const { prompt } = resolveHeadlessForgejoAccess()!;
    expect(prompt).toBe(`## Forgejo access\n\n${capability().description}`);
  });

  it("never puts the token value in the prompt", () => {
    mockConfig.FORGEJO_TOKEN = "fgj_secret_value";
    expect(resolveHeadlessForgejoAccess()!.prompt).not.toContain("fgj_secret_value");
  });

  it("describes Forgejo as the only managed forge and never tells the agent to use gh", () => {
    expect(capability().description).toBe(
      "This repository is hosted on Forgejo, like every repo Claws manages; Claws manages no work on GitHub, so never use `gh` for its issues, PRs, checks, runs or comments. Read and write issues, PRs, labels and comments with curl against the Gitea-compatible API at $CLAWS_FORGEJO_BASE_URL/api/v1, sending the header 'Authorization: token '$CLAWS_FORGEJO_TOKEN — e.g. curl -sH \"Authorization: token $CLAWS_FORGEJO_TOKEN\" \"$CLAWS_FORGEJO_BASE_URL/api/v1/repos/OWNER/NAME/issues\". git fetch and git push against the Forgejo host are already authenticated in this shell via a credential helper, and `origin` already points at Forgejo — do not add a GitHub remote. CI runs on Forgejo Actions from workflows in .forgejo/workflows/, not .github/workflows/. Never print or commit the token.",
    );
  });
});

describe("liveGrantableCapabilities / grantedEnvVars (#3072)", () => {
  beforeEach(() => {
    mockConfig.HOME_ASSISTANT_TOKEN = "ha-token";
    mockConfig.FORGEJO_TOKEN = "fgj";
    mockConfig.FORGEJO_ADMIN_TOKEN = "fgj-admin";
    setClaudeTokens({ primary: "sk-ant-oat01-test" });
  });

  afterEach(() => {
    mockConfig.FORGEJO_TOKEN = "";
    mockConfig.FORGEJO_ADMIN_TOKEN = "";
    setClaudeTokens({});
  });

  const ids = (granted: string[], backend: "k8s-pod", target: LiveGrantTarget = CLAUDE) => liveGrantableCapabilities(granted, backend, target).map((c) => c.id);

  it("offers available, ungranted live-deliverable capabilities, including Forgejo and browser but not cross-repo or agent-login ones", () => {
    const pod = ids([], "k8s-pod");
    expect(pod).toEqual(expect.arrayContaining(["home-assistant", "forgejo", "forgejo-admin", "browser"]));
    for (const id of ["cross-repo", "claude-auth", "codex-auth", "openrouter-auth"]) {
      expect(pod).not.toContain(id);
    }
    expect(ids(["forgejo"], "k8s-pod")).not.toContain("forgejo");
  });

  it("never offers github-auth, even with a GitHub App configured", () => {
    mockConfig.GITHUB_APP_ID = 123;
    expect(ids([], "k8s-pod")).not.toContain("github-auth");
    mockConfig.GITHUB_APP_ID = 0;
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
    const entries = classifyLiveGrants(["ssh:ryzen"], "k8s-pod", CLAUDE);
    const state = (id: string) => entries.find((e) => e.cap.id === id);
    // cross-repo is a baseline, held even when the row's list lacks it, and
    // carries a reason explaining why it's always held (#3372).
    expect(state("cross-repo")).toEqual(expect.objectContaining({ state: "held", reason: "always granted" }));
    expect(state("ssh:ryzen")).toEqual(expect.objectContaining({ state: "held" }));
    expect(state("ssh:ryzen")!.reason).toBeUndefined();
    expect(state("claude-auth")).toBeDefined();
    for (const id of ["claude-auth", "codex-auth", "openrouter-auth"]) {
      const entry = state(id);
      if (!entry) continue; // unconfigured in this mock
      expect(entry).toEqual(expect.objectContaining({ state: "fixed", reason: FIXED_AT_LAUNCH_REASON }));
    }
    expect(state("browser")).toEqual(expect.objectContaining({ state: "grantable" }));
    expect(state("github-auth")).toBeUndefined();
    expect(state("ssh:nas")).toEqual(expect.objectContaining({ state: "grantable" }));
    expect(state("forgejo-admin")).toEqual(expect.objectContaining({ state: "grantable" }));
    // Unconfigured capabilities are absent entirely.
    expect(state("home-assistant")).toBeUndefined();
    expect(entries.map((e) => e.cap.id)).not.toContain("ssh:brendans-macbook-pro-3");
    expect(liveGrantableCapabilities(["ssh:ryzen"], "k8s-pod", CLAUDE).map((c) => c.id))
      .toEqual(entries.filter((e) => e.state === "grantable").map((e) => e.cap.id));
    mockConfig.GITHUB_APP_ID = 0;
  });

  it("classifyLiveGrants makes browser grantable only for a Claude agent session (#clw_01M4RASNVDKH2YBHZMGR0SM0RA)", () => {
    const browser = (target: LiveGrantTarget) => classifyLiveGrants([], "k8s-pod", target).find((e) => e.cap.id === "browser");
    for (const mode of ["worktree-claude", "home-claude", "multi-worktree-claude"] as const) {
      expect(browser({ provider: "claude", mode })).toEqual(expect.objectContaining({ state: "grantable" }));
    }
    for (const provider of ["codex", "opencode", "pi"] as const) {
      const entry = browser({ provider, mode: "worktree-claude" });
      expect(entry).toEqual(expect.objectContaining({ state: "fixed", reason: `${provider} cannot use the browser capability` }));
      expect(entry!.reason).not.toBe(FIXED_AT_LAUNCH_REASON);
      expect(ids([], "k8s-pod", { provider, mode: "worktree-claude" })).not.toContain("browser");
    }
    expect(browser({ provider: "claude", mode: "repo-zsh" })).toEqual(expect.objectContaining({ state: "fixed", reason: "a shell session has no agent to use the browser" }));
    expect(browserUnsupportedReason(CLAUDE)).toBeNull();
    // Held stays held whatever the provider.
    expect(classifyLiveGrants(["browser"], "k8s-pod", CLAUDE).find((e) => e.cap.id === "browser")).toEqual(expect.objectContaining({ state: "held" }));
    // Provider auth keeps the launch-only reason on every provider.
    for (const target of [CLAUDE, CODEX] as const) {
      const entry = classifyLiveGrants([], "k8s-pod", target).find((e) => e.cap.id === "codex-auth");
      if (entry) expect(entry).toEqual(expect.objectContaining({ state: "fixed", reason: FIXED_AT_LAUNCH_REASON }));
    }
  });

  it("buildRequestableCapabilityPrompt names browser and its restart only for a Claude agent session", () => {
    const claude = buildRequestableCapabilityPrompt([], "k8s-pod", CLAUDE);
    expect(claude).toContain("Tools: `browser` (Browser (Playwright))");
    expect(claude.split("\n").at(-1)).toBe("Granting `browser` restarts your agent with the conversation kept so its tools load; expect a brief restart, then continue where you left off.");
    for (const target of [CODEX, { provider: "claude", mode: "repo-zsh" } as const]) {
      const prompt = buildRequestableCapabilityPrompt([], "k8s-pod", target);
      expect(prompt).not.toContain("`browser`");
      expect(prompt).not.toContain("restarts your agent");
    }
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

  it("buildRequestableCapabilityPrompt lists exactly the grantable ids of classifyLiveGrants (#clw_01M5CJ538TE6E1QKZCVPCK0SWY)", () => {
    for (const target of [CLAUDE, CODEX]) {
      const prompt = buildRequestableCapabilityPrompt(["home-assistant"], "k8s-pod", target);
      const promptIds = [...prompt.split("\n").filter((l) => /^[^`]+: `/.test(l)).join("\n").matchAll(/`([^`]+)` \(/g)].map((m) => m[1]).sort();
      const grantable = classifyLiveGrants(["home-assistant"], "k8s-pod", target).filter((e) => e.state === "grantable").map((e) => e.cap.id).sort();
      expect(promptIds).toEqual(grantable);
    }
  });

  it("buildRequestableCapabilityPrompt lists requestable ids and labels one group per line, never descriptions or values", () => {
    const prompt = buildRequestableCapabilityPrompt(["home-assistant"], "k8s-pod", CODEX);
    const lines = prompt.split("\n");
    expect(lines[0]).toBe("## Requestable capabilities");
    expect(lines[1]).toBe("");
    expect(lines[2]).toContain("claws_request_capability");
    expect(lines[2]).toContain("approve");
    // One line per non-empty group, in CAPABILITY_GROUPS order (forge, infra — the granted
    // home-assistant excluded, leaving the always-available observability pair and the
    // no-credential infra-merge — then ssh; agent and tools are empty here), then the delivery note.
    expect(lines).toHaveLength(7);
    expect(lines[3]).toBe("Forge access: `forgejo` (Forgejo (git + API)), `forgejo-admin` (Forgejo admin (Actions secrets))");
    expect(lines[4]).toBe("Infrastructure: `prod-observability` (Prod observability (Grafana)), `fleet-observability` (Fleet observability (Grafana)), `infra-merge` (Infra merge (human merge for OpenTofu PRs))");
    expect(lines[5]).toContain("SSH hosts: `ssh:nas` (SSH: nas (NixOS NAS))");
    expect(lines[5]).toContain("`ssh:brendans-macbook-pro` (SSH: Brendans-MacBook-Pro (macOS Actions runner))");
    // The granted home-assistant is excluded; the disabled Mac never appears.
    expect(prompt).not.toContain("`home-assistant`");
    expect(prompt).not.toContain("brendans-macbook-pro-3");
    expect(prompt).not.toContain("`browser`");
    for (const cap of CAPABILITIES) expect(prompt).not.toContain(cap.description);
    for (const secret of ["ha-token", "fgj"]) expect(prompt).not.toContain(secret);
    expect(lines[6]).toBe("A granted capability is usable within seconds; its credentials are loaded into every new shell automatically, including each Bash tool call — nothing to source.");
  });

  it("buildRequestableCapabilityPrompt offers ssh:* on k8s-pod and says a grant is usable within seconds, auto-loaded", () => {
    const prompt = buildRequestableCapabilityPrompt([], "k8s-pod", CODEX);
    expect(prompt).toContain("SSH hosts: `ssh:nas` (SSH: nas (NixOS NAS))");
    expect(prompt.split("\n").at(-1)).toBe("A granted capability is usable within seconds; its credentials are loaded into every new shell automatically, including each Bash tool call — nothing to source.");
    expect(prompt).not.toContain("about two minutes");
    const allSsh = liveGrantableCapabilities([], "k8s-pod", CLAUDE).filter((c) => c.id.startsWith("ssh:")).map((c) => c.id);
    expect(buildRequestableCapabilityPrompt(allSsh, "k8s-pod", CODEX).split("\n").at(-1)).toBe("A granted capability is usable within seconds; its credentials are loaded into every new shell automatically, including each Bash tool call — nothing to source.");
  });

  it("isLiveRevocable allows only ssh:* hosts", () => {
    expect(isLiveRevocable("ssh:nas")).toBe(true);
    for (const id of ["forgejo", "github-auth", "home-assistant", "cross-repo"]) expect(isLiveRevocable(id)).toBe(false);
  });

  it("buildRequestableCapabilityPrompt is empty when nothing is requestable", () => {
    const everything = liveGrantableCapabilities([], "k8s-pod", CLAUDE).map((c) => c.id);
    expect(buildRequestableCapabilityPrompt(everything, "k8s-pod", CLAUDE)).toBe("");
  });
});

describe("capabilityLabel (#3110)", () => {
  it("returns the registry label for a known id, including an ssh: id", () => {
    expect(capabilityLabel("home-assistant")).toBe("Home Assistant");
    expect(capabilityLabel("ssh:nas")).toBe("SSH: nas (NixOS NAS)");
  });

  it("returns the label of a provider-auth capability even when its resolve() is null", () => {
    setClaudeTokens({});
    expect(isCapabilityAvailable(CLAUDE_AUTH_CAPABILITY_ID)).toBe(false);
    expect(capabilityLabel(CLAUDE_AUTH_CAPABILITY_ID)).toBe("Claude login");
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

  it("puts cross-repo in the forge group, beside forgejo (#3372)", () => {
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

  it("forces forgejo for every one of the given repos", () => {
    expect(autoGrantedRepos(FORGEJO_CAPABILITY_ID, ["owner/a", "owner/forgejo-repo"])).toEqual(["owner/a", "owner/forgejo-repo"]);
    expect(autoGrantedRepos(FORGEJO_CAPABILITY_ID, [])).toEqual([]);
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
    expect(mac1().label).toBe("SSH: Brendans-MacBook-Pro (macOS Actions runner)");
    expect(mac2().id).toBe("ssh:brendans-macbook-pro-3");
    expect(mac2().label).toBe("SSH: Brendans-MacBook-Pro-3 (macOS Actions runner)");
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
    expect(liveGrantableCapabilities([], "k8s-pod", CLAUDE).map((c) => c.id)).toContain("pages");
    expect(liveGrantableCapabilities(["pages"], "k8s-pod", CLAUDE).map((c) => c.id)).not.toContain("pages");
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
    expect(liveGrantableCapabilities([], "k8s-pod", CLAUDE).map((c) => c.id)).toContain("print");
    expect(liveGrantableCapabilities(["print"], "k8s-pod", CLAUDE).map((c) => c.id)).not.toContain("print");
  });
});

describe("pinned SSH host keys", () => {
  const file = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../deploy/ssh-known-hosts");
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));

  it("pins an ed25519 key for every LAN host and address", () => {
    for (const l of lines) expect(l).toMatch(/^\S+ ssh-ed25519 [A-Za-z0-9+/]+$/);
    const hostLists = lines.map((l) => l.split(" ")[0].split(","));
    for (const h of ["nas", "thinkcentre", "ryzen", "thinkcentre.tailc20cf.ts.net", "192.168.0.128", "192.168.0.251", "192.168.0.69"]) {
      expect(hostLists.some((list) => list.includes(h)), h).toBe(true);
    }
  });

  it("pins no retired host and keeps only the one thinkcentre address", () => {
    for (const l of lines) expect(l).not.toMatch(/proxmox|192\.168\.0\.200/);
    for (const l of lines) expect(l).not.toMatch(/k3s\.tailc20cf/);
    for (const l of lines) expect(l.split(" ")[0].split(",")).not.toContain("k3s");
    for (const l of lines) expect(l).not.toMatch(/homeassistant|192\.168\.0\.89/);
  });

  it("tells agents how to tell a missing entry from a changed key", () => {
    const sshCaps = CAPABILITIES.filter((c) => /^ssh:(nas|thinkcentre|ryzen|prod-cluster|prod-data)$/.test(c.id));
    expect(sshCaps.length).toBe(5);
    for (const c of sshCaps) {
      expect(c.description, c.id).toContain("ssh-keygen -F");
    }
  });
});
