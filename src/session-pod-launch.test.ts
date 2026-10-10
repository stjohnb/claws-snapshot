import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockExecFile = vi.hoisted(() => vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(new Error("exit status 1"), "", "")));

const { mockConfig, mockLog } = vi.hoisted(() => ({
  mockConfig: {
    WORK_DIR: "/tmp/claws-launch-test",
    OPENCODE_BEST_MODEL: "openrouter/anthropic/claude-opus-4",
    PI_BEST_MODEL: "anthropic/claude-opus-5-5",
    OPENROUTER_API_KEY: "or-key-secret",
    HOME_ASSISTANT_BASE_URL: "https://ha.example",
    HOME_ASSISTANT_TOKEN: "ha-token-secret",
    PROD_GRAFANA_URL: "",
    PROD_GRAFANA_TOKEN: "",
    FLEET_GRAFANA_URL: "",
    FLEET_GRAFANA_TOKEN: "",
    FORGEJO_BASE_URL: "https://git.example.test",
    FORGEJO_TOKEN: "forgejo-token-secret",
    FORGEJO_READ_TOKEN: "forgejo-read-token-secret",
    FORGEJO_ADMIN_TOKEN: "",
    FORGEJO_REPOS: ["org/forge"] as string[],
    SESSION_BACKEND: "k8s-pod",
    SESSION_POD_SETTINGS: { mcpUrl: "", claudeTheme: "auto" },
    SESSION_AUTO_COMPACT_IDLE_MS: 1_800_000,
    GITHUB_APP_ID: 1,
    GITHUB_OWNER_APP_CREDENTIALS: {},
    DATABASE_URL: "postgres://claws:dbpass-secret@db/claws",
    DATABASE_PASSWORD: "dbpass-secret",
    INTERNAL_MCP_TOKEN: "internal-mcp-secret",
    OPENAI_API_KEY: "openai-secret",
    BROWSER_CDP_ENDPOINT: "",
    GIT_AUTHOR_NAME: "clawsstjohn[bot]",
    GIT_AUTHOR_EMAIL: "276932287+clawsstjohn[bot]@users.noreply.github.com",
    isForgejoRepo: (n: string) => mockConfig.FORGEJO_REPOS.includes(n),
    forgejoRepoUrl: (n: string) => `https://git.example.test/${n}`,
  },
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./config.js", () => mockConfig);
vi.mock("./log.js", () => mockLog);
vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("./db.js", () => ({}));
vi.mock("./github.js", () => ({ listRepos: vi.fn() }));
vi.mock("./claude.js", () => ({ OPENCODE_FULL_PERMISSIONS_CONFIG: '{"permission":"allow"}' }));
vi.mock("./github-app.js", () => ({
  getInstallationTokenForOwner: vi.fn(),
  getAnyInstallationToken: vi.fn(),
  buildEnvForGh: () => ({}),
  // Mirrors the real auth-only shape, Forgejo helper included when a Forgejo token is set; the launcher must never widen it.
  buildGitAuthEnv: (token: string) => ({
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    CLAWS_GIT_CREDENTIAL_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "!helper",
    ...(mockConfig.FORGEJO_TOKEN.trim()
      ? {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_1: "credential.https://git.example.test.helper",
        GIT_CONFIG_VALUE_1: "!forgejo-helper",
        CLAWS_FORGEJO_GIT_TOKEN: mockConfig.FORGEJO_TOKEN,
      }
      : {}),
  }),
}));

import { buildGrantedSecretData, buildPodLaunch, readServiceSshKeys, defaultPodLaunchDeps, podRepoDir, POD_UPLOAD_DIR, POD_SYSTEM_PROMPT_PATH, SESSION_ENV_KEY, CODEX_AUTH_KEY, PI_AUTH_KEY, type PodLaunchDeps, type PodLaunchRequest } from "./session-pod-launch.js";
import { buildAgentArgv, sessionPromptText } from "./sessions.js";
import { CAPABILITIES, validCapabilityIds } from "./capabilities.js";
import { CLONE_ENV_KEY, GITHUB_TOKEN_KEY, GRANTED_ENV_KEY, LAUNCH_SPEC_KEY, MCP_TOKEN_KEY, TERMINAL_TOKEN_KEY, buildWorkloadPod } from "./k8s/workload.js";
import { SESSION_ENV_PATH, GITHUB_TOKEN_PATH, SessionLaunchSpecSchema } from "./session-pod/main.js";

const SECRETS = ["or-key-secret", "sk-ant-oat01-secret", "dbpass-secret", "internal-mcp-secret", "openai-secret", "codex-auth-secret", "gh-token-org"];
const SERVICE_SECRETS = ["dbpass-secret", "internal-mcp-secret", "openai-secret"];

function deps(files: Record<string, string> = {}): PodLaunchDeps & { tokenFor: ReturnType<typeof vi.fn>; anyToken: ReturnType<typeof vi.fn> } {
  const tokenFor = vi.fn(async (owner: string) => `gh-token-${owner}`);
  const anyToken = vi.fn(async () => "gh-token-any");
  return {
    getInstallationTokenForOwner: tokenFor,
    getAnyInstallationToken: anyToken,
    readFile: (p: string) => files[p] ?? null,
    sshDir: "/svc/.ssh",
    gitIdentity: async () => ({ name: "Claws Bot", email: "bot@example.com" }),
    tokenFor,
    anyToken,
  };
}

const base = { id: "0123456789abcdef", model: null, resume: false } as const;

describe("buildPodLaunch", () => {
  const savedClaude = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  const savedCodexHome = process.env["CODEX_HOME"];
  let codexHome: string;
  let codexAuthPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // codex-auth is available only when the service's auth.json really exists.
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "claws-launch-codex-"));
    codexAuthPath = path.join(codexHome, "auth.json");
    fs.writeFileSync(codexAuthPath, "{}");
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-secret";
    process.env["CODEX_HOME"] = codexHome;
    process.env["OPENAI_API_KEY"] = "openai-secret";
    mockConfig.SESSION_POD_SETTINGS.mcpUrl = "";
    mockConfig.BROWSER_CDP_ENDPOINT = "";
  });

  afterEach(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
    if (savedClaude === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = savedClaude;
    if (savedCodexHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = savedCodexHome;
    delete process.env["OPENAI_API_KEY"];
  });

  it("with no provider grant ships no provider credential and nothing ungranted", async () => {
    const d = deps({ [codexAuthPath]: "codex-auth-secret" });
    const launch = await buildPodLaunch({ ...base, mode: "worktree-claude", provider: "claude", repos: ["org/app"], capabilities: [] }, d);

    expect(Object.keys(launch.secretData).sort()).toEqual([
      CLONE_ENV_KEY, LAUNCH_SPEC_KEY, MCP_TOKEN_KEY, TERMINAL_TOKEN_KEY, GITHUB_TOKEN_KEY,
      GRANTED_ENV_KEY, "ssh-id_ed25519", "ssh-id_rsa", "ssh-slots",
    ].sort());
    // clone-env.json carries the clone token by design; it reaches the init container only.
    const { [CLONE_ENV_KEY]: _cloneEnv, ...mainKeys } = launch.secretData;
    const everything = JSON.stringify(mainKeys);
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
    // Key names appear only in the argv strip list (`env -u`), never as an assignment.
    expect(everything).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN=|OPENROUTER_API_KEY=/);
    // An empty slot a mid-session github-auth grant can fill (#3131).
    expect(launch.secretData[GITHUB_TOKEN_KEY]).toBe("");
    expect(launch.spec.envFileKey).toBeUndefined();
    expect(launch.spec.codexAuthKey).toBeUndefined();
    expect(launch.hasGithubToken).toBe(false);
  });

  it("builds a claude worktree session: fresh branch, pod paths and the exact agent argv", async () => {
    const launch = await buildPodLaunch({ ...base, mode: "worktree-claude", provider: "claude", model: "opus", repos: ["org/app"], capabilities: [] }, deps());

    expect(launch.cwd).toBe("/home/claws/work/org/app");
    expect(launch.spec.cwd).toBe(launch.cwd);
    expect(launch.spec.repos).toEqual([{ url: "https://github.com/org/app.git", dir: "/home/claws/work/org/app", branch: "claws-wt/0123456789abcdef" }]);
    expect(launch.spec.uploadDir).toBe(POD_UPLOAD_DIR);
    const mcpPath = "/home/claws/.claws-session/mcp.json";
    const agentArgv = buildAgentArgv({ provider: "claude", promptFile: POD_SYSTEM_PROMPT_PATH, uploadDir: POD_UPLOAD_DIR, mcpConfigPath: mcpPath, extra: [], model: "opus" });
    const cmd = launch.spec.command;
    expect(cmd[0]).toBe("env");
    expect(cmd.slice(cmd.indexOf("claude") + 1)).toEqual(agentArgv);
    expect(cmd).not.toContain("/bin/sh");
    expect(JSON.parse(launch.spec.files.find((f) => f.path === mcpPath)!.content)).toEqual({ mcpServers: {} });
    const promptFile = launch.spec.files.find((f) => f.path === POD_SYSTEM_PROMPT_PATH)!;
    expect(promptFile.content).toBe(`${sessionPromptText([])}\n`);
    // The launch spec round-trips through the pod-side schema.
    expect(SessionLaunchSpecSchema.parse(JSON.parse(launch.secretData[LAUNCH_SPEC_KEY]))).toEqual(launch.spec);
    expect(launch.secretData[TERMINAL_TOKEN_KEY]).toMatch(/^[0-9a-f]{64}$/);
    expect(launch.secretData[MCP_TOKEN_KEY]).toMatch(/^[0-9a-f]{64}$/);
    expect(launch.mcpToken).toBe(launch.secretData[MCP_TOKEN_KEY]);
  });

  it("appends the row's brief to the prompt on launch and on resume", async () => {
    for (const resume of [false, true]) {
      const launch = await buildPodLaunch({ ...base, mode: "worktree-claude", provider: "claude", repos: ["org/app"], capabilities: [], brief: "## Issue brief", resume }, deps());
      const promptFile = launch.spec.files.find((f) => f.path === POD_SYSTEM_PROMPT_PATH)!;
      expect(promptFile.content).toBe(`${sessionPromptText([], undefined, "## Issue brief")}\n`);
    }
  });

  it("gives claude the per-session HTTP claws-state server when CLAWS_SESSION_MCP_URL is set (#3056)", async () => {
    mockConfig.SESSION_POD_SETTINGS.mcpUrl = "http://claws.default.svc.cluster.local:3000";
    const launch = await buildPodLaunch({ ...base, mode: "worktree-claude", provider: "claude", repos: ["org/app"], capabilities: [] }, deps());
    const mcpFile = launch.spec.files.find((f) => f.path.endsWith("mcp.json"))!;
    const mcp = JSON.parse(mcpFile.content);
    expect(mcp.mcpServers["claws-state"]).toEqual({
      type: "http",
      url: "http://claws.default.svc.cluster.local:3000/mcp/sessions/0123456789abcdef",
      headers: { Authorization: `Bearer ${launch.mcpToken}` },
    });
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(["claws-state"]);
    // The pod writes launch files at 0600 unless a mode is given.
    expect(mcpFile.mode).toBeUndefined();
    expect(JSON.parse(launch.secretData[LAUNCH_SPEC_KEY]).files).toContainEqual(mcpFile);
    const everything = JSON.stringify(launch.secretData);
    for (const secret of ["dbpass-secret", "internal-mcp-secret"]) expect(everything).not.toContain(secret);
    // Key names appear only in the argv strip list (`env -u`), never in the MCP config.
    expect(mcpFile.content).not.toMatch(/DATABASE|INTERNAL_MCP_TOKEN/);
  });

  it("isolates browser pods from state diagnostics and requestable guidance", async () => {
    mockConfig.SESSION_POD_SETTINGS.mcpUrl = "http://claws:3000";
    const launch = await buildPodLaunch({ ...base, mode: "worktree-claude", provider: "claude", repos: ["org/app"], capabilities: ["browser"] }, deps());
    const mcp = JSON.parse(launch.spec.files.find((f) => f.path.endsWith("mcp.json"))!.content);
    expect(Object.keys(mcp.mcpServers)).toEqual(["playwright"]);
    expect(JSON.stringify(launch.spec)).not.toMatch(/claws-state|claws_request_capability|claws_runtime_status/);
  });

  it("mints a different MCP token on every launch", async () => {
    mockConfig.SESSION_POD_SETTINGS.mcpUrl = "http://claws:3000";
    const req: PodLaunchRequest = { ...base, mode: "worktree-claude", provider: "claude", repos: ["org/app"], capabilities: [] };
    const first = await buildPodLaunch(req, deps());
    const second = await buildPodLaunch({ ...req, resume: true }, deps());
    expect(first.mcpToken).not.toBe(second.mcpToken);
    const bearer = (l: typeof first) => JSON.parse(l.spec.files.find((f) => f.path.endsWith("mcp.json"))!.content).mcpServers["claws-state"].headers.Authorization;
    expect(bearer(first)).toBe(`Bearer ${first.mcpToken}`);
    expect(bearer(second)).toBe(`Bearer ${second.mcpToken}`);
  });

  it("gives fresh Codex pods remote claws-state config with session-scoped bearer env", async () => {
    mockConfig.SESSION_POD_SETTINGS.mcpUrl = "http://claws:3000";
    const launch = await buildPodLaunch({ ...base, mode: "repo-claude", provider: "codex", repos: ["org/app"], capabilities: [] }, deps());
    const config = launch.spec.files.find((f) => f.path === "/home/claws/.codex/config.toml")!.content;

    expect(config).toContain("[mcp_servers.claws-state]");
    expect(config).toContain('url = "http://claws:3000/mcp/sessions/0123456789abcdef"');
    expect(config).toContain('bearer_token_env_var = "CLAWS_SESSION_MCP_TOKEN"');
    expect(config).toContain("claws_runtime_status");
    expect(config).toContain("claws_request_capability");
    expect(launch.secretData[SESSION_ENV_KEY]).toContain(`export CLAWS_SESSION_MCP_TOKEN='${launch.mcpToken}'`);
    expect(launch.spec.command).not.toContain("--mcp-config");
    const everything = JSON.stringify({ spec: launch.spec, secretData: launch.secretData });
    for (const secret of SERVICE_SECRETS) expect(everything).not.toContain(secret);
    expect(config).not.toContain(launch.mcpToken);
  });

  it("regenerates Codex remote claws-state URL/token config on revive", async () => {
    mockConfig.SESSION_POD_SETTINGS.mcpUrl = "http://claws:3000/";
    const req: PodLaunchRequest = { ...base, mode: "repo-claude", provider: "codex", repos: ["org/app"], capabilities: [] };
    const first = await buildPodLaunch(req, deps());
    const revived = await buildPodLaunch({ ...req, resume: true }, deps());

    expect(first.mcpToken).not.toBe(revived.mcpToken);
    expect(first.secretData[SESSION_ENV_KEY]).toContain(`export CLAWS_SESSION_MCP_TOKEN='${first.mcpToken}'`);
    expect(revived.secretData[SESSION_ENV_KEY]).toContain(`export CLAWS_SESSION_MCP_TOKEN='${revived.mcpToken}'`);
    const config = revived.spec.files.find((f) => f.path === "/home/claws/.codex/config.toml")!.content;
    expect(config).toContain('url = "http://claws:3000/mcp/sessions/0123456789abcdef"');
    expect(config).toContain('bearer_token_env_var = "CLAWS_SESSION_MCP_TOKEN"');
    expect(revived.spec.command.slice(revived.spec.command.indexOf("codex") + 1, revived.spec.command.indexOf("codex") + 3)).toEqual(["resume", "--last"]);
  });

  it("gives fresh OpenCode pods remote claws-state config while retaining instructions and permissions", async () => {
    mockConfig.SESSION_POD_SETTINGS.mcpUrl = "http://claws:3000";
    const launch = await buildPodLaunch({ ...base, mode: "repo-claude", provider: "opencode", repos: ["org/app"], capabilities: [] }, deps());
    const config = JSON.parse(launch.spec.files.find((f) => f.path === "/home/claws/.claws-session/opencode/opencode.json")!.content);
    const instructionsPath = "/home/claws/.claws-session/opencode/claws-session-instructions.md";
    const instructions = launch.spec.files.find((f) => f.path === instructionsPath)!.content;

    expect(config.instructions).toEqual([instructionsPath]);
    expect(config.mcp["claws-state"]).toEqual({
      type: "remote",
      url: "http://claws:3000/mcp/sessions/0123456789abcdef",
      headers: { Authorization: `Bearer ${launch.mcpToken}` },
    });
    expect(instructions).toContain("claws_runtime_status");
    expect(instructions).toContain("claws_request_capability");
    expect(launch.secretData[SESSION_ENV_KEY]).toContain("export OPENCODE_CONFIG='/home/claws/.claws-session/opencode/opencode.json'");
    expect(launch.secretData[SESSION_ENV_KEY]).toContain("export OPENCODE_CONFIG_CONTENT='{\"permission\":\"allow\"}'");
    const everything = JSON.stringify({ spec: launch.spec, secretData: launch.secretData });
    for (const secret of SERVICE_SECRETS) expect(everything).not.toContain(secret);
  });

  it("regenerates OpenCode remote claws-state bearer token on revive", async () => {
    mockConfig.SESSION_POD_SETTINGS.mcpUrl = "http://claws:3000";
    const req: PodLaunchRequest = { ...base, mode: "repo-claude", provider: "opencode", repos: ["org/app"], capabilities: [] };
    const first = await buildPodLaunch(req, deps());
    const revived = await buildPodLaunch({ ...req, resume: true }, deps());

    expect(first.mcpToken).not.toBe(revived.mcpToken);
    const firstConfig = JSON.parse(first.spec.files.find((f) => f.path.endsWith("opencode.json"))!.content);
    const revivedConfig = JSON.parse(revived.spec.files.find((f) => f.path.endsWith("opencode.json"))!.content);
    expect(firstConfig.mcp["claws-state"].headers.Authorization).toBe(`Bearer ${first.mcpToken}`);
    expect(revivedConfig.mcp["claws-state"].headers.Authorization).toBe(`Bearer ${revived.mcpToken}`);
    expect(revived.spec.command).toContain("--continue");
  });

  it("lists requestable capabilities, ssh:* included (#3322), only when the provider has the claws-state server (#3072)", async () => {
    const promptOf = (l: Awaited<ReturnType<typeof buildPodLaunch>>) => l.spec.files.find((f) => f.path === POD_SYSTEM_PROMPT_PATH)!.content;
    const req: PodLaunchRequest = { ...base, mode: "repo-claude", provider: "claude", repos: ["org/app"], capabilities: [] };

    const noMcp = await buildPodLaunch(req, deps());
    expect(promptOf(noMcp)).not.toContain("Requestable capabilities");

    mockConfig.SESSION_POD_SETTINGS.mcpUrl = "http://claws:3000";
    const withMcp = await buildPodLaunch(req, deps());
    const block = promptOf(withMcp).slice(promptOf(withMcp).indexOf("## Requestable capabilities"));
    expect(block).toContain("claws_request_capability");
    expect(block).toContain("`home-assistant`");
    expect(block).toContain("`ssh:nas`");
    expect(block).toContain("becomes usable within about two minutes");
    expect(block).not.toContain("Read/control the Home Assistant instance");

    const codex = await buildPodLaunch({ ...req, provider: "codex" }, deps());
    expect(codex.spec.files.find((f) => f.path.endsWith("config.toml"))!.content).toContain("Requestable capabilities");
    const opencode = await buildPodLaunch({ ...req, provider: "opencode" }, deps());
    expect(opencode.spec.files.find((f) => f.path.endsWith("claws-session-instructions.md"))!.content).toContain("Requestable capabilities");
  });

  it("gives claude a Playwright-only MCP config when browser is granted", async () => {
    const launch = await buildPodLaunch({ ...base, mode: "home-claude", provider: "claude", repos: [], capabilities: ["browser"] }, deps());
    const mcp = JSON.parse(launch.spec.files.find((f) => f.path.endsWith("mcp.json"))!.content);
    expect(Object.keys(mcp.mcpServers)).toEqual(["playwright"]);
    expect(JSON.stringify(mcp)).not.toContain("claws-state");
  });

  it("gives a local-Chromium browser session a headless profile on the PVC and no env file", async () => {
    const launch = await buildPodLaunch({ ...base, mode: "home-claude", provider: "claude", repos: [], capabilities: ["browser"] }, deps());
    const mcp = JSON.parse(launch.spec.files.find((f) => f.path.endsWith("mcp.json"))!.content);
    expect(mcp.mcpServers.playwright).toEqual({
      command: "npx",
      args: ["@playwright/mcp@latest", "--headless", "--user-data-dir", "/home/claws/.claws-session/browser-profile"],
    });
    expect(launch.secretData[SESSION_ENV_KEY]).toBeUndefined();
  });

  it("points a browser session at the shared service through the session env file only (#3102)", async () => {
    const endpoint = "ws://browser.default.svc.cluster.local:3000/?token=browserless-secret";
    mockConfig.BROWSER_CDP_ENDPOINT = endpoint;
    const launch = await buildPodLaunch({ ...base, mode: "home-claude", provider: "claude", repos: [], capabilities: ["browser"] }, deps());

    const mcpContent = launch.spec.files.find((f) => f.path.endsWith("mcp.json"))!.content;
    expect(JSON.parse(mcpContent).mcpServers.playwright).toEqual({ command: "npx", args: ["@playwright/mcp@latest"] });
    expect(mcpContent).not.toMatch(/--user-data-dir|--headless|browserless-secret/);
    expect(launch.spec.envFileKey).toBe(SESSION_ENV_KEY);
    expect(launch.secretData[SESSION_ENV_KEY]).toContain(`export PLAYWRIGHT_MCP_CDP_ENDPOINT='${endpoint}'`);
    expect(launch.spec.command.join(" ")).not.toContain("browserless-secret");
    expect(JSON.stringify(launch.spec)).not.toContain("browserless-secret");
    const pod = JSON.stringify(buildWorkloadPod({ kind: "session", id: base.id, namespace: "ns", image: "img", secretKeys: Object.keys(launch.secretData) }));
    expect(pod).not.toContain("browserless-secret");

    // Without the browser capability the endpoint never reaches the pod.
    const noBrowser = await buildPodLaunch({ ...base, mode: "home-claude", provider: "claude", repos: [], capabilities: [] }, deps());
    expect(JSON.stringify(noBrowser.secretData)).not.toContain("browserless-secret");
  });

  it("puts granted vars and claude-auth into the env file", async () => {
    const launch = await buildPodLaunch({
      ...base, mode: "repo-claude", provider: "claude", repos: ["org/app"],
      capabilities: ["claude-auth", "home-assistant"],
    }, deps());

    const env = launch.secretData[SESSION_ENV_KEY];
    expect(launch.spec.envFileKey).toBe(SESSION_ENV_KEY);
    expect(env).toContain("export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-secret'");
    expect(env).toContain("export HOME_ASSISTANT_TOKEN='ha-token-secret'");
    expect(env).not.toContain("KUBECONFIG");
    expect(env).not.toContain("OPENROUTER_API_KEY");
    expect(Object.keys(launch.secretData).filter((k) => k.includes("kubeconfig"))).toEqual([]);
    // The argv carries the prelude path only, never a value.
    const cmd = launch.spec.command;
    expect(cmd[cmd.indexOf("claws-session") + 1]).toBe(SESSION_ENV_PATH);
    expect(cmd.join(" ")).not.toContain("sk-ant-oat01-secret");
    // repo-claude clones the default branch.
    expect(launch.spec.repos[0].branch).toBeUndefined();
  });

  it("puts cross-repo read env in the session env without Forgejo push helpers", async () => {
    const launch = await buildPodLaunch({
      ...base, mode: "repo-claude", provider: "claude", repos: ["org/app"],
      capabilities: ["cross-repo"],
    }, deps());

    const env = launch.secretData[SESSION_ENV_KEY];
    expect(env).toContain("export CLAWS_FORGEJO_READ_TOKEN='forgejo-read-token-secret'");
    expect(env).toContain("export CLAWS_FORGEJO_BASE_URL='https://git.example.test'");
    expect(env).not.toContain("CLAWS_FORGEJO_TOKEN");
    expect(env).not.toContain("CLAWS_FORGEJO_GIT_TOKEN");
    expect(env).not.toContain("GIT_CONFIG_");
  });

  it("ships github-token for the first GitHub repo's owner and a gitconfig that reads it", async () => {
    const d = deps();
    const launch = await buildPodLaunch({ ...base, mode: "multi-worktree-claude", provider: "claude", repos: ["org/forge", "acme/app", "org/other"], capabilities: ["github-auth"] }, d);

    expect(launch.secretData[GITHUB_TOKEN_KEY]).toBe("gh-token-acme");
    expect(launch.hasGithubToken).toBe(true);
    const gitconfig = launch.spec.files.find((f) => f.path === "/home/claws/.gitconfig")!;
    expect(gitconfig.onlyIfAbsent).toBe(true);
    expect(gitconfig.content).toContain('[credential "https://github.com"]');
    expect(gitconfig.content).toContain(`test -s ${GITHUB_TOKEN_PATH} || exit 0`);
    expect(gitconfig.content).toContain('name = "Claws Bot"');
    // Extra repos are --add-dir'd.
    expect(launch.spec.command).toContain(podRepoDir("acme/app"));
    expect(launch.spec.repos.map((r) => r.url)).toEqual([
      "https://git.example.test/org/forge.git",
      "https://github.com/acme/app.git",
      "https://github.com/org/other.git",
    ]);
  });

  it("defaultPodLaunchDeps.gitIdentity falls back to the canonical author when the service host has no global git identity", async () => {
    const identity = await defaultPodLaunchDeps.gitIdentity();
    expect(identity).toEqual({ name: mockConfig.GIT_AUTHOR_NAME, email: mockConfig.GIT_AUTHOR_EMAIL });
  });

  it("uses any installation token for github-auth when no repo is GitHub-hosted", async () => {
    const d = deps();
    const launch = await buildPodLaunch({ ...base, mode: "home-claude", provider: "claude", repos: [], capabilities: ["github-auth"] }, d);
    expect(launch.secretData[GITHUB_TOKEN_KEY]).toBe("gh-token-any");
    expect(d.anyToken).toHaveBeenCalled();
  });

  it("builds clone-env.json from auth vars only, and a Forgejo-only env for Forgejo repos", async () => {
    const gh = await buildPodLaunch({ ...base, mode: "repo-zsh", provider: "claude", repos: ["org/app"], capabilities: [] }, deps());
    const cloneEnv = JSON.parse(gh.secretData[CLONE_ENV_KEY]);
    expect(cloneEnv.GH_TOKEN).toBe("gh-token-org");
    expect(Object.keys(cloneEnv).every((k) => /^(GIT_|GH_TOKEN|GITHUB_TOKEN|CLAWS_[A-Z_]*GIT_[A-Z_]*TOKEN)/.test(k))).toBe(true);
    expect(cloneEnv.PATH).toBeUndefined();

    const fj = await buildPodLaunch({ ...base, mode: "repo-zsh", provider: "claude", repos: ["org/forge"], capabilities: ["forgejo"] }, deps());
    const fjEnv = JSON.parse(fj.secretData[CLONE_ENV_KEY]);
    expect(fjEnv.CLAWS_FORGEJO_GIT_TOKEN).toBe("forgejo-token-secret");
    expect(fjEnv.GIT_CONFIG_KEY_0).toBe("credential.https://git.example.test.helper");
    expect(fjEnv.CLAWS_FORGEJO_TOKEN).toBeUndefined();
  });

  it("clones a mixed GitHub + Forgejo set with both credential helpers", async () => {
    const launch = await buildPodLaunch({ ...base, mode: "multi-worktree-claude", provider: "claude", repos: ["org/app", "org/forge"], capabilities: ["forgejo"] }, deps());

    const cloneEnv = JSON.parse(launch.secretData[CLONE_ENV_KEY]);
    expect(cloneEnv).toMatchObject({
      GH_TOKEN: "gh-token-org",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_KEY_1: "credential.https://git.example.test.helper",
      GIT_CONFIG_VALUE_1: "!forgejo-helper",
      CLAWS_FORGEJO_GIT_TOKEN: "forgejo-token-secret",
    });
    expect(launch.spec.repos.map((r) => r.url)).toContain("https://git.example.test/org/forge.git");
  });

  it("refuses a Forgejo repo when no Forgejo token is configured, instead of failing the clone in the pod", async () => {
    const saved = mockConfig.FORGEJO_TOKEN;
    mockConfig.FORGEJO_TOKEN = "";
    try {
      const message = "Forgejo repo org/forge has no clone credential: CLAWS_FORGEJO_TOKEN is not configured";
      await expect(buildPodLaunch({ ...base, mode: "multi-worktree-claude", provider: "claude", repos: ["org/app", "org/forge"], capabilities: [] }, deps())).rejects.toThrow(message);
      await expect(buildPodLaunch({ ...base, mode: "repo-zsh", provider: "claude", repos: ["org/forge"], capabilities: [] }, deps())).rejects.toThrow(message);
    } finally {
      mockConfig.FORGEJO_TOKEN = saved;
    }
  });

  it("runs zsh with no agent argv for repo-zsh", async () => {
    mockConfig.SESSION_POD_SETTINGS.mcpUrl = "http://claws:3000";
    const launch = await buildPodLaunch({ ...base, mode: "repo-zsh", provider: "claude", repos: ["org/app"], capabilities: [] }, deps());
    expect(launch.spec.command[launch.spec.command.length - 1]).toBe("zsh");
    expect(launch.spec.files.some((f) => f.path.endsWith("mcp.json"))).toBe(false);
    expect(JSON.stringify(launch.spec)).not.toContain("claws-state");
  });

  it("home-claude gets no clone and runs in HOME", async () => {
    const launch = await buildPodLaunch({ ...base, mode: "home-claude", provider: "claude", repos: ["org/app"], capabilities: [] }, deps());
    expect(launch.cwd).toBe("/home/claws");
    expect(launch.spec.repos).toEqual([]);
    expect(launch.secretData[CLONE_ENV_KEY]).toBeUndefined();
  });

  it("codex: config.toml, codex-auth only when granted, resume --last on resume", async () => {
    const files = { [codexAuthPath]: "codex-auth-secret" };
    const launch = await buildPodLaunch({ ...base, mode: "repo-claude", provider: "codex", repos: ["org/app"], capabilities: ["codex-auth"], resume: true }, deps(files));
    expect(launch.secretData[CODEX_AUTH_KEY]).toBe("codex-auth-secret");
    expect(launch.spec.codexAuthKey).toBe(CODEX_AUTH_KEY);
    expect(launch.spec.codexHome).toBe("/home/claws/.codex");
    const codexConfig = launch.spec.files.find((f) => f.path === "/home/claws/.codex/config.toml")?.content;
    expect(codexConfig).toContain("developer_instructions");
    expect(codexConfig).toContain("check_for_update_on_startup = false");
    const cmd = launch.spec.command;
    expect(cmd.slice(cmd.indexOf("codex") + 1, cmd.indexOf("codex") + 3)).toEqual(["resume", "--last"]);
  });

  it("mounts the empty github-token slot in the main container when github-auth is not granted (#3131)", async () => {
    const launch = await buildPodLaunch({ ...base, mode: "repo-claude", provider: "claude", repos: ["org/app"], capabilities: [] }, deps());
    const pod = buildWorkloadPod({ kind: "session", id: base.id, namespace: "ns", image: "img", secretKeys: Object.keys(launch.secretData) });
    const volumes = (pod.spec as { volumes: Array<{ name: string; secret?: { items: Array<{ key: string }> } }> }).volumes;
    expect(volumes.find((v) => v.name === "secret")!.secret!.items.map((i) => i.key)).toContain(GITHUB_TOKEN_KEY);
  });

  it("asks claude sessions only to skip Claude Code's first-run screens, trusting every checkout (#3131)", async () => {
    const multi = await buildPodLaunch({ ...base, mode: "multi-worktree-claude", provider: "claude", repos: ["acme/app", "org/other"], capabilities: [] }, deps());
    expect(multi.spec.claudeSetup).toEqual({ theme: "auto", trustDirs: [podRepoDir("acme/app"), podRepoDir("org/other")] });
    expect(SessionLaunchSpecSchema.parse(JSON.parse(multi.secretData[LAUNCH_SPEC_KEY])).claudeSetup).toEqual(multi.spec.claudeSetup);
    const home = await buildPodLaunch({ ...base, mode: "home-claude", provider: "claude", repos: [], capabilities: [] }, deps());
    expect(home.spec.claudeSetup).toEqual({ theme: "auto", trustDirs: ["/home/claws"] });
    const zsh = await buildPodLaunch({ ...base, mode: "repo-zsh", provider: "claude", repos: ["org/app"], capabilities: [] }, deps());
    expect(zsh.spec).not.toHaveProperty("claudeSetup");
    const codex = await buildPodLaunch({ ...base, mode: "repo-claude", provider: "codex", repos: ["org/app"], capabilities: [] }, deps());
    expect(codex.spec).not.toHaveProperty("claudeSetup");
  });

  it("points every session's exit report at Claws when CLAWS_SESSION_MCP_URL is set (#3311)", async () => {
    mockConfig.SESSION_POD_SETTINGS.mcpUrl = "http://claws:3000//";
    for (const mode of ["repo-claude", "repo-zsh"] as const) {
      const launch = await buildPodLaunch({ ...base, mode, provider: "codex", repos: ["org/app"], capabilities: [] }, deps());
      expect(launch.spec.exitReportUrl).toBe("http://claws:3000/session-pods/0123456789abcdef/exit");
      expect(SessionLaunchSpecSchema.parse(JSON.parse(launch.secretData[LAUNCH_SPEC_KEY])).exitReportUrl).toBe(launch.spec.exitReportUrl);
    }
    mockConfig.SESSION_POD_SETTINGS.mcpUrl = "";
    const unset = await buildPodLaunch({ ...base, mode: "repo-claude", provider: "claude", repos: ["org/app"], capabilities: [] }, deps());
    expect(unset.spec).not.toHaveProperty("exitReportUrl");
  });

  it("sets autoCompactIdleMs for claude agent sessions only (#3090)", async () => {
    const claude = await buildPodLaunch({ ...base, mode: "home-claude", provider: "claude", repos: [], capabilities: [] }, deps());
    expect(claude.spec.autoCompactIdleMs).toBe(1_800_000);
    expect(SessionLaunchSpecSchema.parse(JSON.parse(claude.secretData[LAUNCH_SPEC_KEY])).autoCompactIdleMs).toBe(1_800_000);
    const zsh = await buildPodLaunch({ ...base, mode: "repo-zsh", provider: "claude", repos: ["org/app"], capabilities: [] }, deps());
    expect(zsh.spec).not.toHaveProperty("autoCompactIdleMs");
    const codex = await buildPodLaunch({ ...base, mode: "repo-claude", provider: "codex", repos: ["org/app"], capabilities: [] }, deps());
    expect(codex.spec).not.toHaveProperty("autoCompactIdleMs");
  });

  it("claude resume passes --continue", async () => {
    const launch = await buildPodLaunch({ ...base, mode: "worktree-claude", provider: "claude", repos: ["org/app"], capabilities: [], resume: true }, deps());
    expect(launch.spec.command).toContain("--continue");
  });

  it("opencode: OPENROUTER_API_KEY only with openrouter-auth, config via env file", async () => {
    const without = await buildPodLaunch({ ...base, mode: "repo-claude", provider: "opencode", repos: ["org/app"], capabilities: [] }, deps());
    expect(without.secretData[SESSION_ENV_KEY]).toContain("export OPENCODE_CONFIG='/home/claws/.claws-session/opencode/opencode.json'");
    expect(without.secretData[SESSION_ENV_KEY]).not.toContain("OPENROUTER_API_KEY");

    const granted = await buildPodLaunch({ ...base, mode: "repo-claude", provider: "opencode", repos: ["org/app"], capabilities: ["openrouter-auth"], resume: true }, deps());
    expect(granted.secretData[SESSION_ENV_KEY]).toContain("export OPENROUTER_API_KEY='or-key-secret'");
    expect(granted.spec.command).toContain("--continue");
  });

  it("pi: remote claws-state in ~/.pi/agent/mcp.json with the bearer in the env file, role prompt in APPEND_SYSTEM.md", async () => {
    mockConfig.SESSION_POD_SETTINGS.mcpUrl = "http://claws:3000";
    const launch = await buildPodLaunch({ ...base, mode: "repo-claude", provider: "pi", repos: ["org/app"], capabilities: [] }, deps());
    const mcp = JSON.parse(launch.spec.files.find((f) => f.path === "/home/claws/.pi/agent/mcp.json")!.content);
    expect(mcp.mcpServers["claws-state"]).toEqual({
      url: "http://claws:3000/mcp/sessions/0123456789abcdef",
      headers: { Authorization: "Bearer ${PI_SESSION_MCP_TOKEN}" },
      timeout: 300,
    });
    const prompt = launch.spec.files.find((f) => f.path === "/home/claws/.pi/agent/APPEND_SYSTEM.md")!.content;
    expect(prompt).toContain("claws_runtime_status");
    expect(prompt).toContain("claws_request_capability");
    const env = launch.secretData[SESSION_ENV_KEY];
    expect(env).toContain(`export PI_SESSION_MCP_TOKEN='${launch.mcpToken}'`);
    expect(env).toContain("export PI_SKIP_VERSION_CHECK='1'");
    expect(env).toContain("export PI_TELEMETRY='0'");
    const cmd = launch.spec.command;
    expect(cmd.slice(cmd.indexOf("pi"))).toEqual(["pi", "--no-approve", "--provider", "anthropic", "--model", "claude-opus-5-5"]);
    expect(JSON.stringify(launch.spec.files)).not.toContain(launch.mcpToken);
    expect(launch.spec).not.toHaveProperty("claudeSetup");
  });

  it("pi: credentials and piAuthKey only with pi-auth, --continue on resume", async () => {
    fs.writeFileSync(codexAuthPath, JSON.stringify({ tokens: { access_token: "codex-auth-secret", refresh_token: "r", account_id: "acct" } }));
    const without = await buildPodLaunch({ ...base, mode: "repo-claude", provider: "pi", repos: ["org/app"], capabilities: [] }, deps());
    expect(without.secretData[SESSION_ENV_KEY]).not.toMatch(/ANTHROPIC_OAUTH_TOKEN|OPENAI_API_KEY|OPENROUTER_API_KEY/);
    expect(without.secretData[PI_AUTH_KEY]).toBeUndefined();
    expect(without.spec.piAuthKey).toBeUndefined();
    const everything = JSON.stringify({ spec: without.spec, secretData: without.secretData });
    for (const secret of ["sk-ant-oat01-secret", "openai-secret", "or-key-secret", "codex-auth-secret"]) expect(everything).not.toContain(secret);

    const granted = await buildPodLaunch({ ...base, mode: "repo-claude", provider: "pi", repos: ["org/app"], capabilities: ["pi-auth"], resume: true }, deps());
    const env = granted.secretData[SESSION_ENV_KEY];
    expect(env).toContain("export ANTHROPIC_OAUTH_TOKEN='sk-ant-oat01-secret'");
    expect(env).toContain("export OPENAI_API_KEY='openai-secret'");
    expect(env).toContain("export OPENROUTER_API_KEY='or-key-secret'");
    expect(JSON.parse(granted.secretData[PI_AUTH_KEY])["openai-codex"]).toMatchObject({ type: "oauth", access: "codex-auth-secret", refresh: "r", accountId: "acct" });
    expect(granted.spec.piAuthKey).toBe(PI_AUTH_KEY);
    expect(SessionLaunchSpecSchema.parse(JSON.parse(granted.secretData[LAUNCH_SPEC_KEY])).piAuthKey).toBe(PI_AUTH_KEY);
    expect(granted.spec.command.join(" ")).not.toContain("sk-ant-oat01-secret");
    expect(granted.spec.command).toContain("--continue");
  });

  it("pi: no piAuthKey when the Codex login is unusable", async () => {
    const launch = await buildPodLaunch({ ...base, mode: "repo-claude", provider: "pi", repos: ["org/app"], capabilities: ["pi-auth"] }, deps());
    expect(launch.secretData[PI_AUTH_KEY]).toBeUndefined();
    expect(launch.spec.piAuthKey).toBeUndefined();
    expect(launch.secretData[SESSION_ENV_KEY]).toContain("export ANTHROPIC_OAUTH_TOKEN='sk-ant-oat01-secret'");
  });

  const SSH_SLOTS = [{ key: "ssh-id_ed25519", name: "id_ed25519" }, { key: "ssh-id_rsa", name: "id_rsa" }];

  it("mounts both SSH key slots on every launch, filled with only the private keys when ssh is granted", async () => {
    const files = { "/svc/.ssh/id_ed25519": "ssh-key-material-xyz", "/svc/.ssh/config": "Host nas" };
    const none = await buildPodLaunch({ ...base, mode: "home-claude", provider: "claude", repos: [], capabilities: [] }, deps(files));
    expect(none.spec.ssh).toEqual(SSH_SLOTS);
    expect(none.secretData["ssh-id_ed25519"]).toBe("");
    expect(none.secretData["ssh-id_rsa"]).toBe("");
    expect(JSON.stringify(none.secretData)).not.toContain("ssh-key-material-xyz");
    const pod = JSON.stringify(buildWorkloadPod({ kind: "session", id: base.id, namespace: "ns", image: "img", secretKeys: Object.keys(none.secretData) }));
    expect(pod).toContain("\"ssh-id_ed25519\"");
    expect(pod).toContain("\"ssh-id_rsa\"");

    const granted = await buildPodLaunch({ ...base, mode: "home-claude", provider: "claude", repos: [], capabilities: ["ssh:nas"] }, deps(files));
    expect(granted.spec.ssh).toEqual(SSH_SLOTS);
    expect(granted.secretData["ssh-id_ed25519"]).toBe("ssh-key-material-xyz");
    expect(granted.secretData["ssh-id_rsa"]).toBe("");
    expect(granted.secretData["ssh-config"]).toBeUndefined();
    expect(JSON.stringify(granted.secretData)).not.toContain("Host nas");
    expect(mockLog.warn).not.toHaveBeenCalledWith(expect.stringContaining("SSH granted"));
  });

  it("warns when ssh is granted but no private key is available", async () => {
    const granted = await buildPodLaunch({ ...base, mode: "home-claude", provider: "claude", repos: [], capabilities: ["ssh:nas"] }, deps({ "/svc/.ssh/config": "Host nas" }));

    expect(granted.spec.ssh).toEqual(SSH_SLOTS);
    expect(granted.secretData["ssh-id_ed25519"]).toBe("");
    expect(JSON.stringify(granted.secretData)).not.toContain("Host nas");
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("no usable private key"));
  });

  it("readServiceSshKeys returns each present, non-empty private key by its Secret slot", () => {
    expect(readServiceSshKeys(deps({ "/svc/.ssh/id_rsa": "rsa", "/svc/.ssh/id_ed25519": "", "/svc/.ssh/config": "Host nas" }))).toEqual({ "ssh-id_rsa": "rsa" });
    expect(readServiceSshKeys(deps({}))).toEqual({});
  });

  it("ships an empty granted-capability slot on every launch, mounted in the main container (#3072)", async () => {
    const launch = await buildPodLaunch({ ...base, mode: "repo-claude", provider: "claude", repos: ["org/app"], capabilities: ["home-assistant"] }, deps());

    expect(launch.secretData[GRANTED_ENV_KEY]).toBe("# Capabilities granted mid-session are written here by Claws\n");

    const pod = buildWorkloadPod({ kind: "session", id: base.id, namespace: "ns", image: "img", secretKeys: Object.keys(launch.secretData) });
    const volumes = (pod.spec as { volumes: Array<{ name: string; secret?: { items: Array<{ key: string }> } }> }).volumes;
    const mainItems = volumes.find((v) => v.name === "secret")!.secret!.items.map((i) => i.key);
    expect(mainItems).toContain(GRANTED_ENV_KEY);
  });

  it("propagates a clone-token mint failure", async () => {
    const d = deps();
    d.getInstallationTokenForOwner = vi.fn(async () => { throw new Error("mint failed"); });
    await expect(buildPodLaunch({ ...base, mode: "repo-zsh", provider: "claude", repos: ["org/app"], capabilities: [] }, d)).rejects.toThrow("mint failed");
  });

  // #clw_01M3HH9MM5J348FTZ4T9AY67Y2: tmux's client.c rejects a packed
  // `new-session` command once its argv exceeds MAX_IMSGSIZE (16,384 bytes)
  // minus a small header — a tmux-imposed limit, not the OS's much larger
  // ARG_MAX. The whole point of delivering the prompt through a file
  // (`--append-system-prompt-file`) is that the tmux argv stays a small,
  // constant size no matter how many repos or capabilities are granted.
  it("keeps the tmux argv well under tmux's ~16 KB new-session limit with every repo and capability granted", async () => {
    mockConfig.SESSION_POD_SETTINGS.mcpUrl = "http://claws:3000";
    const repos = ["org/app", "org/infra", "org/forge", "acme/site", "acme/api", "org/tools", "org/docs", "acme/edge"];
    const capabilities = validCapabilityIds(CAPABILITIES.map((c) => c.id));
    expect(capabilities.length).toBeGreaterThan(5);
    const d = deps({ [codexAuthPath]: "codex-auth-secret" });

    const launch = await buildPodLaunch(
      { ...base, mode: "multi-worktree-claude", provider: "claude", repos, capabilities },
      d,
    );

    const byteSize = launch.spec.command.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0);
    expect(byteSize).toBeLessThan(16_000);

    const promptFile = launch.spec.files.find((f) => f.path === POD_SYSTEM_PROMPT_PATH)!;
    for (const cap of CAPABILITIES) {
      if (capabilities.includes(cap.id)) expect(promptFile.content).toContain(cap.label);
    }

    expect(SessionLaunchSpecSchema.parse(JSON.parse(launch.secretData[LAUNCH_SPEC_KEY]))).toEqual(launch.spec);
  });
});

describe("buildGrantedSecretData (#3072)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports every granted capability's vars in the single granted-env slot", () => {
    const data = buildGrantedSecretData(["home-assistant", "ssh:nas"]);

    expect(Object.keys(data)).toEqual([GRANTED_ENV_KEY]);
    const env = data[GRANTED_ENV_KEY];
    expect(env.startsWith(
      "# Capabilities granted mid-session are written here by Claws\n# claws-granted: home-assistant\n# claws-granted: ssh:nas\n",
    )).toBe(true);
    expect(env).toContain("export HOME_ASSISTANT_TOKEN='ha-token-secret'");
    expect(env).not.toContain("KUBECONFIG");
  });

  it("carries no ungranted value", () => {
    const data = buildGrantedSecretData(["ssh:nas"]);

    const everything = JSON.stringify(data);
    for (const secret of ["ha-token-secret", "forgejo-token-secret", "or-key-secret"]) expect(everything).not.toContain(secret);
  });

  it("exports cross-repo read vars without Forgejo push helpers", () => {
    const data = buildGrantedSecretData(["cross-repo"]);

    expect(data[GRANTED_ENV_KEY]).toContain("export CLAWS_FORGEJO_READ_TOKEN='forgejo-read-token-secret'");
    expect(data[GRANTED_ENV_KEY]).toContain("export CLAWS_FORGEJO_BASE_URL='https://git.example.test'");
    expect(data[GRANTED_ENV_KEY]).not.toContain("CLAWS_FORGEJO_TOKEN");
    expect(data[GRANTED_ENV_KEY]).not.toContain("CLAWS_FORGEJO_GIT_TOKEN");
    expect(data[GRANTED_ENV_KEY]).not.toContain("GIT_CONFIG_");
  });

  it("exports Forgejo live-access vars and git helper config", () => {
    const data = buildGrantedSecretData(["cross-repo", "forgejo"]);

    expect(data[GRANTED_ENV_KEY]).toContain("export CLAWS_FORGEJO_READ_TOKEN='forgejo-read-token-secret'");
    expect(data[GRANTED_ENV_KEY]).toContain("export CLAWS_FORGEJO_TOKEN='forgejo-token-secret'");
    expect(data[GRANTED_ENV_KEY]).toContain("export CLAWS_FORGEJO_BASE_URL='https://git.example.test'");
    expect(data[GRANTED_ENV_KEY]).toContain("export CLAWS_FORGEJO_GIT_TOKEN='forgejo-token-secret'");
    expect(data[GRANTED_ENV_KEY]).toContain("export GIT_CONFIG_COUNT='1'");
    expect(data[GRANTED_ENV_KEY]).toContain("export GIT_CONFIG_KEY_0='credential.https://git.example.test.helper'");
    expect(data[GRANTED_ENV_KEY]).toContain("export GIT_CONFIG_VALUE_0=");
    expect(data[GRANTED_ENV_KEY]).toContain("password=$CLAWS_FORGEJO_GIT_TOKEN");
  });
});
