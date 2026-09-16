import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockConfig = vi.hoisted(() => ({
  HOME_ASSISTANT_BASE_URL: "",
  HOME_ASSISTANT_TOKEN: "",
  PROD_K8S_KUBECONFIG_PATH: "",
  FLEET_KUBECONFIG_PATH: "",
  FORGEJO_TOKEN: "",
  FORGEJO_ADMIN_TOKEN: "",
  FORGEJO_BASE_URL: "https://git.example.test",
  FORGEJO_REPOS: [] as string[],
  isForgejoRepo: (n: string) => mockConfig.FORGEJO_REPOS.some((r) => r.toLowerCase() === n.toLowerCase()),
  SESSION_BACKEND: "local-tmux" as "local-tmux" | "k8s-pod",
  OPENROUTER_API_KEY: "",
  GITHUB_APP_ID: 0,
  GITHUB_OWNER_APP_CREDENTIALS: {} as Record<string, { appId?: number; privateKeyPath?: string }>,
}));

vi.mock("./config.js", () => mockConfig);

import {
  buildCapabilityEnvArgs,
  buildCapabilityPrompt,
  buildRequestableCapabilityPrompt,
  resolveCapabilityEnv,
  validCapabilityIds,
  availableCapabilities,
  isCapabilityAvailable,
  REPO_CAPABILITY_DEFAULTS,
  reposForCapability,
  defaultCapabilitiesForRepo,
  withImplicitCapabilities,
  defaultProviderAuthCapabilities,
  CAPABILITIES,
  resolveHeadlessForgejoAccess,
  liveGrantableCapabilities,
  grantedEnvVars,
  capabilityLabel,
  CLAUDE_AUTH_CAPABILITY_ID,
} from "./capabilities.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The gated env keys across the whole registry.
const ALL_KEYS = [
  "HOME_ASSISTANT_BASE_URL",
  "HOME_ASSISTANT_TOKEN",
  "CLAWS_HOME_ASSISTANT_TOKEN",
  "KUBECONFIG",
  "CLAWS_FORGEJO_TOKEN",
  "CLAWS_FORGEJO_BASE_URL",
  "CLAWS_FORGEJO_GIT_TOKEN",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "CLAWS_FORGEJO_ADMIN_TOKEN",
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
    mockConfig.PROD_K8S_KUBECONFIG_PATH = "/etc/prod.kubeconfig";
    mockConfig.FLEET_KUBECONFIG_PATH = "/etc/fleet.kubeconfig";
    mockConfig.FORGEJO_TOKEN = "";
    mockConfig.FORGEJO_ADMIN_TOKEN = "";
    mockConfig.FORGEJO_BASE_URL = "https://git.example.test";
    mockConfig.FORGEJO_REPOS = [];
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
  it.each([[[]], [["home-assistant"]], [["prod-infra", "fleet-infra"]]])(
    "never puts a value on argv for selection %j",
    (selected: string[]) => {
      const args = buildCapabilityEnvArgs(selected, "/tmp/s.env");
      expect(args.every((a) => !a.includes("ha-token"))).toBe(true);
      expect(args.every((a) => !a.includes("kubeconfig"))).toBe(true);
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

  it("colon-merges KUBECONFIG when both prod and fleet are granted", () => {
    expect(resolveCapabilityEnv(["prod-infra", "fleet-infra"]).vars.KUBECONFIG).toBe(
      "/etc/prod.kubeconfig:/etc/fleet.kubeconfig",
    );
  });

  it("validCapabilityIds rejects unknown ids and dedupes", () => {
    expect(validCapabilityIds(["bogus", "home-assistant", "home-assistant"])).toEqual([
      "home-assistant",
    ]);
  });

  it("availableCapabilities reflects configured credentials", () => {
    mockConfig.FLEET_KUBECONFIG_PATH = "";
    const ids = availableCapabilities().map((c) => c.id);
    expect(ids).toContain("home-assistant");
    expect(ids).toContain("prod-infra");
    expect(ids).not.toContain("fleet-infra");
  });

  it("expands ~ in FLEET_KUBECONFIG_PATH for the granted KUBECONFIG", () => {
    mockConfig.FLEET_KUBECONFIG_PATH = "~/.kube/config";
    const kube = resolveCapabilityEnv(["fleet-infra"]).vars.KUBECONFIG;
    expect(kube).toBeDefined();
    expect(kube).not.toContain("~");
    expect(kube).toMatch(/\/\.kube\/config$/);
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
    expect(ids.filter((id) => id.startsWith("ssh:")).length).toBe(5);
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

describe("forgejo capability (#2871)", () => {
  it("is unavailable with no token, even when a repo is Forgejo-hosted", () => {
    mockConfig.FORGEJO_REPOS = ["St-John-Software/perudo"];
    expect(isCapabilityAvailable("forgejo")).toBe(false);
    expect(availableCapabilities().map((c) => c.id)).not.toContain("forgejo");
    expect(validCapabilityIds(["forgejo"])).toEqual([]);
    expect(withImplicitCapabilities([], ["St-John-Software/perudo"])).toEqual([]);
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
    expect(ids.filter((id) => id === "forgejo").length).toBe(1);
  });

  it("withImplicitCapabilities grants nothing for a GitHub-only repo set", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    mockConfig.FORGEJO_REPOS = ["St-John-Software/perudo"];
    expect(withImplicitCapabilities([], ["owner/gh"])).not.toContain("forgejo");
    expect(withImplicitCapabilities([], [null])).not.toContain("forgejo");
  });

  it("buildCapabilityEnvArgs never puts the token or an assignment on argv", () => {
    mockConfig.FORGEJO_TOKEN = "tok";
    mockConfig.FORGEJO_REPOS = ["St-John-Software/perudo"];
    const args = buildCapabilityEnvArgs(["forgejo"], "/tmp/s.env");
    expect(args.every((a) => !a.includes("tok"))).toBe(true);
    expect(assignments(args)).toEqual([]);
  });

  it("the registry entry is marked implicit; every other entry is not", () => {
    const forgejo = CAPABILITIES.find((c) => c.id === "forgejo");
    expect(forgejo?.implicit).toBe(true);
    for (const cap of CAPABILITIES) {
      if (cap.id === "forgejo") continue;
      expect(cap.implicit).not.toBe(true);
    }
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
    expect(ids).toEqual(["forgejo"]);
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
  it("fleet-infra repo defaults include fleet-infra and ssh:proxmox", () => {
    expect(REPO_CAPABILITY_DEFAULTS["St-John-Software/fleet-infra"]).toContain("fleet-infra");
    expect(REPO_CAPABILITY_DEFAULTS["St-John-Software/fleet-infra"]).toContain("ssh:proxmox");
  });

  it("reposForCapability('prod-infra') returns production-infra, namey, bonkus", () => {
    expect(reposForCapability("prod-infra")).toEqual([
      "St-John-Software/production-infra",
      "St-John-Software/namey",
      "St-John-Software/bonkus",
    ]);
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

describe("provider-auth capabilities (#3026)", () => {
  const PROVIDER_AUTH = ["claude-auth", "codex-auth", "openrouter-auth", "github-auth"];
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
    mockConfig.SESSION_BACKEND = "local-tmux";
    mockConfig.HOME_ASSISTANT_TOKEN = "ha-token";
  });

  afterEach(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
    mockConfig.SESSION_BACKEND = "local-tmux";
    if (savedEnv.claude === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = savedEnv.claude;
    if (savedEnv.codexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = savedEnv.codexHome;
  });

  it("are unavailable under local-tmux even with every source credential present", () => {
    for (const id of PROVIDER_AUTH) expect(isCapabilityAvailable(id)).toBe(false);
    expect(validCapabilityIds(PROVIDER_AUTH)).toEqual([]);
  });

  it("are available under k8s-pod when their source credential exists", () => {
    mockConfig.SESSION_BACKEND = "k8s-pod";
    expect(validCapabilityIds(PROVIDER_AUTH)).toEqual(PROVIDER_AUTH);
  });

  it("drop out under k8s-pod when their source credential is missing", () => {
    mockConfig.SESSION_BACKEND = "k8s-pod";
    delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    fs.rmSync(path.join(codexHome, "auth.json"));
    mockConfig.OPENROUTER_API_KEY = "";
    mockConfig.GITHUB_APP_ID = 0;
    expect(validCapabilityIds(PROVIDER_AUTH)).toEqual([]);
    mockConfig.GITHUB_OWNER_APP_CREDENTIALS = { "St-John-Software": { appId: 9, privateKeyPath: "/k.pem" } };
    expect(validCapabilityIds(PROVIDER_AUTH)).toEqual(["github-auth"]);
  });

  it("own no env keys, so local strip lists are unchanged and nothing is injected", () => {
    mockConfig.SESSION_BACKEND = "k8s-pod";
    for (const id of PROVIDER_AUTH) {
      const cap = CAPABILITIES.find((c) => c.id === id)!;
      expect(cap.envKeys).toEqual([]);
      expect(cap.resolve()).toEqual({});
    }
    mockConfig.SESSION_BACKEND = "local-tmux";
    const { stripKeys } = resolveCapabilityEnv([]);
    expect(stripKeys).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(buildCapabilityEnvArgs([], null)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("carry their provider and appear in the capability prompt when granted", () => {
    mockConfig.SESSION_BACKEND = "k8s-pod";
    expect(CAPABILITIES.find((c) => c.id === "claude-auth")?.provider).toBe("claude");
    expect(CAPABILITIES.find((c) => c.id === "codex-auth")?.provider).toBe("codex");
    expect(CAPABILITIES.find((c) => c.id === "openrouter-auth")?.provider).toBe("opencode");
    expect(CAPABILITIES.find((c) => c.id === "github-auth")?.provider).toBe("github");
    expect(buildCapabilityPrompt(["github-auth"])).toContain("GitHub (gh + git)");
  });

  it.each([
    ["claude", "worktree-claude", ["claude-auth"]],
    ["claude", "home-claude", ["claude-auth"]],
    ["codex", "repo-claude", ["codex-auth"]],
    ["opencode", "worktree-claude", ["openrouter-auth"]],
    ["claude", "multi-worktree-claude", ["claude-auth"]],
    ["claude", "repo-zsh", []],
    ["codex", "repo-zsh", []],
  ] as const)("defaultProviderAuthCapabilities(%s, %s) → %j", (provider, mode, expected) => {
    expect(defaultProviderAuthCapabilities(provider, mode)).toEqual(expected);
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
    mockConfig.PROD_K8S_KUBECONFIG_PATH = "/etc/prod.kubeconfig";
    mockConfig.FLEET_KUBECONFIG_PATH = "/etc/fleet.kubeconfig";
    mockConfig.FORGEJO_TOKEN = "fgj";
    mockConfig.FORGEJO_ADMIN_TOKEN = "fgj-admin";
    mockConfig.SESSION_BACKEND = "local-tmux";
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-test";
  });

  afterEach(() => {
    mockConfig.SESSION_BACKEND = "local-tmux";
    mockConfig.FORGEJO_TOKEN = "";
    mockConfig.FORGEJO_ADMIN_TOKEN = "";
    if (savedClaude === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = savedClaude;
  });

  const ids = (granted: string[], backend: "local-tmux" | "k8s-pod") => liveGrantableCapabilities(granted, backend).map((c) => c.id);

  it("offers available, ungranted capabilities, never implicit, provider-auth or browser ones", () => {
    mockConfig.SESSION_BACKEND = "k8s-pod";
    const pod = ids([], "k8s-pod");
    expect(pod).toEqual(expect.arrayContaining(["home-assistant", "prod-infra", "fleet-infra", "forgejo-admin"]));
    for (const id of ["forgejo", "browser", "claude-auth", "codex-auth", "openrouter-auth", "github-auth"]) {
      expect(pod).not.toContain(id);
    }
  });

  it("drops what is already granted and what is unconfigured", () => {
    mockConfig.HOME_ASSISTANT_TOKEN = "";
    const local = ids(["prod-infra"], "local-tmux");
    expect(local).not.toContain("prod-infra");
    expect(local).not.toContain("home-assistant");
    expect(local).toContain("fleet-infra");
  });

  it("offers ssh:* on local-tmux only", () => {
    expect(ids([], "local-tmux")).toContain("ssh:nas");
    expect(ids([], "k8s-pod").some((id) => id.startsWith("ssh:"))).toBe(false);
  });

  it("grantedEnvVars merges every granted capability's vars, KUBECONFIG colon-joined", () => {
    expect(grantedEnvVars(["prod-infra", "fleet-infra"]).KUBECONFIG).toBe("/etc/prod.kubeconfig:/etc/fleet.kubeconfig");
    expect(grantedEnvVars(["home-assistant"])).toEqual({
      HOME_ASSISTANT_BASE_URL: mockConfig.HOME_ASSISTANT_BASE_URL,
      HOME_ASSISTANT_TOKEN: "ha-token",
      CLAWS_HOME_ASSISTANT_TOKEN: "ha-token",
    });
    expect(grantedEnvVars(["ssh:nas"])).toEqual({});
  });

  it("buildRequestableCapabilityPrompt lists requestable ids and labels on one line, never descriptions or values", () => {
    const prompt = buildRequestableCapabilityPrompt(["prod-infra"], "local-tmux");
    const lines = prompt.split("\n");
    expect(lines[0]).toBe("## Requestable capabilities");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("claws_request_capability");
    expect(lines[2]).toContain("approve");
    expect(lines[3]).toContain("`fleet-infra` (Fleet infra (kubectl))");
    expect(lines[3]).toContain("`ssh:nas` (SSH: nas)");
    expect(lines[3]).not.toContain("`prod-infra`");
    expect(prompt).not.toContain("`browser`");
    expect(prompt).not.toContain("`forgejo`");
    for (const cap of CAPABILITIES) expect(prompt).not.toContain(cap.description);
    for (const secret of ["ha-token", "fgj", "/etc/fleet.kubeconfig"]) expect(prompt).not.toContain(secret);
    expect(buildRequestableCapabilityPrompt([], "k8s-pod")).not.toContain("ssh:");
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

  it("returns the label of a provider-auth capability even when its resolve() is null on local-tmux", () => {
    expect(mockConfig.SESSION_BACKEND).toBe("local-tmux");
    expect(isCapabilityAvailable(CLAUDE_AUTH_CAPABILITY_ID)).toBe(false);
    expect(capabilityLabel(CLAUDE_AUTH_CAPABILITY_ID)).toBe("Claude login");
  });

  it("returns the id unchanged for an id not in the registry", () => {
    expect(capabilityLabel("no-such-capability")).toBe("no-such-capability");
  });
});
