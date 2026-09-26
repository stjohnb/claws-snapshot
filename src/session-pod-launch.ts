import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as log from "./log.js";
import { BROWSER_CDP_ENDPOINT, GIT_AUTHOR_EMAIL, GIT_AUTHOR_NAME, OPENROUTER_API_KEY, SESSION_AUTO_COMPACT_IDLE_MS, SESSION_POD_SETTINGS, forgejoRepoUrl, isForgejoRepo } from "./config.js";
import {
  BROWSER_CAPABILITY_ID,
  CAPABILITIES,
  CLAUDE_AUTH_CAPABILITY_ID,
  CODEX_AUTH_CAPABILITY_ID,
  FORGEJO_CAPABILITY_ID,
  GITHUB_AUTH_CAPABILITY_ID,
  OPENROUTER_AUTH_CAPABILITY_ID,
  buildCapabilityEnvArgs,
  serviceCodexAuthPath,
  validCapabilityIds,
} from "./capabilities.js";
import { buildAgentArgv, sessionPromptText, type SessionMode, type SessionProvider } from "./sessions.js";
import {
  codexConfigBody,
  codexRemoteMcpServersToml,
  opencodeConfigBody,
  renderGrantedEnvFile,
  renderSessionEnvFile,
  type OpencodeRemoteMcpServer,
} from "./session-env-file.js";
import {
  buildEnvForGh,
  buildGitAuthEnv,
  getAnyInstallationToken,
  getInstallationTokenForOwner,
} from "./github-app.js";
import { OPENCODE_FULL_PERMISSIONS_CONFIG } from "./claude.js";
import { PLAYWRIGHT_CDP_ENV_KEY, PLAYWRIGHT_MCP_PACKAGE, usesRemoteBrowser } from "./browser-endpoint.js";
import {
  CLONE_ENV_KEY,
  GITHUB_TOKEN_KEY,
  SSH_PRIVATE_KEY_FILES,
  sshKeySecretKey,
  GRANTED_ENV_KEY,
  LAUNCH_SPEC_KEY,
  MCP_TOKEN_KEY,
  TERMINAL_TOKEN_KEY,
  WORKLOAD_HOME,
  WORKLOAD_SECRET_DIR,
  grantedKubeconfigKey,
} from "./k8s/workload.js";
import { GITHUB_TOKEN_PATH, SESSION_ENV_PATH, type SessionLaunchSpec } from "./session-pod/main.js";

// Builds what a `k8s-pod` session pod is launched from (#3026): the launch spec
// and the Secret data. Runs inside Claws. The Secret gets only what the
// session was granted — never `OPENAI_API_KEY`, the database URL/password or
// `INTERNAL_MCP_TOKEN` — and clone credentials go only to `clone-env.json`,
// which the pod builder projects into the init container alone.

/** Secret key of the session env file sourced by the argv prelude. */
export const SESSION_ENV_KEY = "session.env";
/** Secret key of the granted Codex `auth.json`. */
export const CODEX_AUTH_KEY = "codex-auth.json";
/** Claws-owned per-session state inside the pod's HOME. */
export const POD_SESSION_STATE_DIR = path.posix.join(WORKLOAD_HOME, ".claws-session");
export const POD_UPLOAD_DIR = path.posix.join(POD_SESSION_STATE_DIR, "uploads");
const POD_MCP_CONFIG_PATH = path.posix.join(POD_SESSION_STATE_DIR, "mcp.json");
const POD_OPENCODE_DIR = path.posix.join(POD_SESSION_STATE_DIR, "opencode");
const POD_CODEX_HOME = path.posix.join(WORKLOAD_HOME, ".codex");
const CLAWS_STATE_MCP_NAME = "claws-state";
const CODEX_SESSION_MCP_TOKEN_ENV = "CLAWS_SESSION_MCP_TOKEN";

/** Where a repo is checked out inside the pod: `~/work/<owner>/<name>`. */
export function podRepoDir(fullName: string): string {
  return path.posix.join(WORKLOAD_HOME, "work", fullName);
}

export function podCloneUrl(fullName: string): string {
  return isForgejoRepo(fullName) ? `${forgejoRepoUrl(fullName)}.git` : `https://github.com/${fullName}.git`;
}

export interface PodLaunchRequest {
  id: string;
  mode: SessionMode;
  provider: SessionProvider;
  model: string | null;
  /** Full repo names; the first is the working directory. Empty for home sessions. */
  repos: string[];
  /** Effective capability grant (already through `withImplicitCapabilities`). */
  capabilities: string[];
  /** Relaunch on an existing PVC: agents continue their last conversation. */
  resume: boolean;
}

export interface PodLaunch {
  spec: SessionLaunchSpec;
  secretData: Record<string, string>;
  /** Absolute working directory inside the pod. */
  cwd: string;
  /** Checkout dir per repo, in request order. */
  repoDirs: Array<{ repo: string; dir: string }>;
  terminalToken: string;
  /** Bearer token for this session's `claws-state` MCP endpoint in Claws; fresh on every launch. */
  mcpToken: string;
  /** True when the Secret carries a `github-token` that reconcile must keep fresh. */
  hasGithubToken: boolean;
}

export interface PodLaunchDeps {
  getInstallationTokenForOwner: (owner: string) => Promise<string>;
  getAnyInstallationToken: () => Promise<string>;
  /** Reads a service-side file (Codex auth, kubeconfig, SSH); null when absent. */
  readFile: (p: string) => string | null;
  /** The service's `~/.ssh`. */
  sshDir: string;
  /** The service's git `user.name` / `user.email`, when set. */
  gitIdentity: () => Promise<{ name?: string; email?: string }>;
}

function readFileOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

const execFileAsync = promisify(execFile);

/** Async so a session create/resume never blocks the event loop on `git`. */
async function serviceGitIdentity(): Promise<{ name?: string; email?: string }> {
  const get = async (key: string): Promise<string | undefined> => {
    try {
      const { stdout } = await execFileAsync("git", ["config", "--global", "--get", key], {
        env: buildEnvForGh(null),
        timeout: 5_000,
        encoding: "utf8",
      });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
  // The service host has no global git identity, so fall back to the same
  // canonical author/committer Claws injects into its own git subprocesses (#3206).
  return { name: name ?? GIT_AUTHOR_NAME, email: email ?? GIT_AUTHOR_EMAIL };
}

export const defaultPodLaunchDeps: PodLaunchDeps = {
  getInstallationTokenForOwner,
  getAnyInstallationToken,
  readFile: readFileOrNull,
  sshDir: path.join(os.homedir(), ".ssh"),
  gitIdentity: serviceGitIdentity,
};

function gitConfigQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

function sessionClawsStateMcp(id: string, token: string): { url: string; authorization: string } {
  const baseUrl = SESSION_POD_SETTINGS.mcpUrl.replace(/\/+$/, "");
  return { url: `${baseUrl}/mcp/sessions/${id}`, authorization: `Bearer ${token}` };
}

/** Where the pod's terminal server POSTs the process's exit code and final output (#3311). */
function sessionExitReportUrl(id: string): string {
  return `${SESSION_POD_SETTINGS.mcpUrl.replace(/\/+$/, "")}/session-pods/${id}/exit`;
}

/**
 * `~/.gitconfig` for a new session PVC (written only if absent, so the user's
 * later edits survive resume). The github.com credential helper reads the
 * mounted `github-token`, which Claws refreshes in place, at every git call.
 */
export function buildPodGitconfig(identity: { name?: string; email?: string }): string {
  const helper = `!f() { test "$1" = get || exit 0; test -s ${GITHUB_TOKEN_PATH} || exit 0; echo username=x-access-token; echo "password=$(cat ${GITHUB_TOKEN_PATH})"; }; f`;
  const lines = [
    "# Written by Claws when this session's storage was created; never overwritten.",
    '[credential "https://github.com"]',
    `\thelper = ${gitConfigQuote(helper)}`,
  ];
  if (identity.name || identity.email) {
    lines.push("[user]");
    if (identity.name) lines.push(`\tname = ${gitConfigQuote(identity.name)}`);
    if (identity.email) lines.push(`\temail = ${gitConfigQuote(identity.email)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Clone credentials for the init container: auth vars only, never a whole env.
 * Throws when a Forgejo repo is in the set but no Forgejo token is configured,
 * rather than letting its clone fail in the pod on an opaque auth error.
 */
async function buildCloneEnv(repos: string[], deps: PodLaunchDeps): Promise<Record<string, string> | null> {
  if (repos.length === 0) return null;
  const githubRepo = repos.find((r) => !isForgejoRepo(r));
  let env: Record<string, string> | null = null;
  if (githubRepo) {
    // With a Forgejo token configured this also carries the Forgejo host's credential helper, so a mixed set clones both.
    env = buildGitAuthEnv(await deps.getInstallationTokenForOwner(githubRepo.split("/")[0]));
  } else {
    // Forgejo-only: reuse the forgejo capability's credential-helper vars.
    const forgejo = CAPABILITIES.find((c) => c.id === FORGEJO_CAPABILITY_ID)?.resolve();
    if (forgejo) {
      env = { GIT_TERMINAL_PROMPT: "0" };
      for (const [k, v] of Object.entries(forgejo)) {
        if (k.startsWith("GIT_") || k === "CLAWS_FORGEJO_GIT_TOKEN") env[k] = v;
      }
    }
  }
  const forgejoRepo = repos.find((r) => isForgejoRepo(r));
  if (forgejoRepo && !env?.CLAWS_FORGEJO_GIT_TOKEN) {
    throw new Error(`Forgejo repo ${forgejoRepo} has no clone credential: CLAWS_FORGEJO_TOKEN is not configured`);
  }
  return env;
}

/**
 * Resolve the vars of capabilities `ids` for a pod. A KUBECONFIG is a
 * service-side path, so its contents go in `files` under Secret key
 * `keyFor(capId)` and KUBECONFIG points at the mounted keys, colon-joined. An
 * unreadable kubeconfig is left out with a warning naming `context`.
 */
function resolvePodCapabilityEnv(
  ids: string[],
  keyFor: (capId: string) => string,
  readFile: (p: string) => string | null,
  context: string,
): { vars: Record<string, string>; files: Record<string, string> } {
  const vars: Record<string, string> = {};
  const files: Record<string, string> = {};
  const kubeconfigs: string[] = [];
  for (const id of ids) {
    const resolved = CAPABILITIES.find((c) => c.id === id)?.resolve();
    if (!resolved) continue;
    for (const [k, v] of Object.entries(resolved)) {
      if (k !== "KUBECONFIG") {
        vars[k] = v;
        continue;
      }
      const content = readFile(v);
      if (content === null) {
        log.warn(`[session-pod-launch] ${id}: kubeconfig ${v} is unreadable — not granted to ${context}`);
        continue;
      }
      const key = keyFor(id);
      files[key] = content;
      kubeconfigs.push(path.posix.join(WORKLOAD_SECRET_DIR, key));
    }
  }
  if (kubeconfigs.length > 0) vars.KUBECONFIG = kubeconfigs.join(":");
  return { vars, files };
}

const GRANTED_ENV_HEADER = "# Capabilities granted mid-session are written here by Claws\n";

/**
 * The Secret slot keys for capabilities granted to a running pod session
 * (#3072): `granted-env` plus one `granted-kubeconfig-<capId>` per registry
 * capability that sets KUBECONFIG. Every slot is always returned — empty when
 * not granted — so the keys exist from launch (the pod mounts only the keys
 * listed at launch) and one PATCH rewrites them all. `granted-env` exports the
 * vars of every capability in `caps`, with KUBECONFIG pointing at the mounted
 * slots, colon-joined, under a `grantedEnvMarker` line per capability so a
 * reader can tell the eventually-synced mount is current. An unreadable
 * kubeconfig is left out.
 */
export function buildGrantedSecretData(caps: string[], readFile: (p: string) => string | null): Record<string, string> {
  const granted = validCapabilityIds(caps);
  const data: Record<string, string> = {};
  for (const cap of CAPABILITIES) {
    if (cap.envKeys.includes("KUBECONFIG")) data[grantedKubeconfigKey(cap.id)] = "";
  }
  const { vars, files } = resolvePodCapabilityEnv(granted, grantedKubeconfigKey, readFile, "the session");
  Object.assign(data, files);
  data[GRANTED_ENV_KEY] = GRANTED_ENV_HEADER + renderGrantedEnvFile(granted, vars);
  return data;
}

/**
 * Build the launch spec and Secret data for one pod launch. Throws when a
 * required credential cannot be minted (e.g. the clone token); callers treat
 * that as the runtime being unavailable.
 */
export async function buildPodLaunch(req: PodLaunchRequest, deps: PodLaunchDeps = defaultPodLaunchDeps): Promise<PodLaunch> {
  const caps = validCapabilityIds(req.capabilities);
  const secretData: Record<string, string> = {};
  const files: SessionLaunchSpec["files"] = [];
  const isAgent = req.mode !== "repo-zsh";
  const command = isAgent ? req.provider : "zsh";

  // ── Checkout layout ──
  const branch = req.mode === "worktree-claude" || req.mode === "multi-worktree-claude" ? `claws-wt/${req.id}` : undefined;
  const cloneRepos = req.mode === "home-claude" ? [] : req.repos;
  const repoDirs = cloneRepos.map((repo) => ({ repo, dir: podRepoDir(repo) }));
  const cwd = repoDirs[0]?.dir ?? WORKLOAD_HOME;
  const specRepos = repoDirs.map(({ repo, dir }) => ({ url: podCloneUrl(repo), dir, ...(branch ? { branch } : {}) }));

  // ── Session env file ──
  // Kubeconfig contents ship as mounted Secret keys; the resolved paths are host/service files.
  const { vars, files: kubeconfigFiles } = resolvePodCapabilityEnv(caps, (id) => `kubeconfig-${id}`, deps.readFile, `session ${req.id}`);
  Object.assign(secretData, kubeconfigFiles);
  if (caps.includes(CLAUDE_AUTH_CAPABILITY_ID) && process.env["CLAUDE_CODE_OAUTH_TOKEN"]) {
    vars.CLAUDE_CODE_OAUTH_TOKEN = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  }
  if (caps.includes(OPENROUTER_AUTH_CAPABILITY_ID) && OPENROUTER_API_KEY) {
    vars.OPENROUTER_API_KEY = OPENROUTER_API_KEY;
  }

  // ── Agent files and argv ──
  // Agent pods with the claws-state server can call read-only diagnostics and claws_request_capability (#3072/#3172).
  const includeClawsState = isAgent && !!SESSION_POD_SETTINGS.mcpUrl && !caps.includes(BROWSER_CAPABILITY_ID);
  const prompt = sessionPromptText(caps, includeClawsState ? "k8s-pod" : undefined);
  const mcpToken = crypto.randomBytes(32).toString("hex");
  const clawsState = includeClawsState ? sessionClawsStateMcp(req.id, mcpToken) : null;
  let agentArgs: string[] = [];
  if (isAgent) {
    const addDirArgs = repoDirs.slice(1).flatMap(({ dir }) => ["--add-dir", dir]);
    if (req.provider === "claude") {
      const servers: Record<string, unknown> = {};
      // claws-state is served by Claws itself over HTTP (#3056), so no database
      // credentials or internal MCP token enter the pod. Its bearer token acts
      // only as this session, stops working when the session ends, and is
      // replaced whenever the pod is relaunched.
      if (clawsState) {
        servers[CLAWS_STATE_MCP_NAME] = {
          type: "http",
          url: clawsState.url,
          headers: { Authorization: clawsState.authorization },
        };
      }
      if (caps.includes(BROWSER_CAPABILITY_ID)) {
        if (usesRemoteBrowser()) {
          // Shared browser service (#3102): the tokened URL reaches the MCP server
          // only through the sourced-then-deleted session env file, which claude
          // passes on to it — never mcp.json on the PVC or the Pod spec. No
          // profile dir: the service gives each connection a fresh browser.
          vars[PLAYWRIGHT_CDP_ENV_KEY] = BROWSER_CDP_ENDPOINT;
          servers.playwright = { command: "npx", args: [PLAYWRIGHT_MCP_PACKAGE] };
        } else {
          servers.playwright = {
            command: "npx",
            args: [PLAYWRIGHT_MCP_PACKAGE, "--headless", "--user-data-dir", path.posix.join(POD_SESSION_STATE_DIR, "browser-profile")],
          };
        }
      }
      files.push({ path: POD_MCP_CONFIG_PATH, content: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n` });
      agentArgs = buildAgentArgv({
        provider: "claude",
        prompt,
        uploadDir: POD_UPLOAD_DIR,
        mcpConfigPath: POD_MCP_CONFIG_PATH,
        extra: req.resume ? ["--continue", ...addDirArgs] : addDirArgs,
        model: req.model,
      });
    } else if (req.provider === "codex") {
      const mcpServersToml = clawsState
        ? codexRemoteMcpServersToml(CLAWS_STATE_MCP_NAME, clawsState.url, CODEX_SESSION_MCP_TOKEN_ENV)
        : "";
      if (clawsState) vars[CODEX_SESSION_MCP_TOKEN_ENV] = mcpToken;
      files.push({ path: path.posix.join(POD_CODEX_HOME, "config.toml"), content: codexConfigBody(prompt, mcpServersToml) });
      agentArgs = buildAgentArgv({
        provider: "codex",
        prompt,
        uploadDir: POD_UPLOAD_DIR,
        mcpConfigPath: null,
        extra: addDirArgs,
        resume: req.resume,
        model: req.model,
      });
    } else {
      const instructionsPath = path.posix.join(POD_OPENCODE_DIR, "claws-session-instructions.md");
      const configPath = path.posix.join(POD_OPENCODE_DIR, "opencode.json");
      const mcp: Record<string, OpencodeRemoteMcpServer> = clawsState
        ? {
            [CLAWS_STATE_MCP_NAME]: {
              type: "remote",
              url: clawsState.url,
              headers: { Authorization: clawsState.authorization },
            },
          }
        : {};
      files.push({ path: instructionsPath, content: prompt.endsWith("\n") ? prompt : `${prompt}\n` });
      files.push({
        path: configPath,
        content: opencodeConfigBody(instructionsPath, mcp),
      });
      vars.OPENCODE_CONFIG = configPath;
      vars.OPENCODE_CONFIG_CONTENT = OPENCODE_FULL_PERMISSIONS_CONFIG;
      agentArgs = buildAgentArgv({
        provider: "opencode",
        prompt,
        uploadDir: POD_UPLOAD_DIR,
        mcpConfigPath: null,
        extra: [],
        resume: req.resume,
        model: req.model,
      });
    }
  }
  files.push({ path: path.posix.join(WORKLOAD_HOME, ".gitconfig"), content: buildPodGitconfig(await deps.gitIdentity()), onlyIfAbsent: true });

  const hasEnvFile = Object.keys(vars).length > 0;
  if (hasEnvFile) secretData[SESSION_ENV_KEY] = renderSessionEnvFile(vars);
  const commandArgv = [...buildCapabilityEnvArgs(caps, hasEnvFile ? SESSION_ENV_PATH : null), command, ...agentArgs];

  // ── Other Secret keys ──
  let codexAuthKey: string | undefined;
  if (caps.includes(CODEX_AUTH_CAPABILITY_ID)) {
    const auth = deps.readFile(serviceCodexAuthPath());
    if (auth === null) {
      log.warn(`[session-pod-launch] codex-auth granted but ${serviceCodexAuthPath()} is unreadable — session ${req.id} starts logged out`);
    } else {
      secretData[CODEX_AUTH_KEY] = auth;
      codexAuthKey = CODEX_AUTH_KEY;
    }
  }

  let hasGithubToken = false;
  if (caps.includes(GITHUB_AUTH_CAPABILITY_ID)) {
    const githubRepo = req.repos.find((r) => !isForgejoRepo(r));
    secretData[GITHUB_TOKEN_KEY] = githubRepo
      ? await deps.getInstallationTokenForOwner(githubRepo.split("/")[0])
      : await deps.getAnyInstallationToken();
    hasGithubToken = true;
  } else {
    // Empty slot so a mid-session github-auth grant can fill it: the pod mounts only launch-time keys (#3131).
    secretData[GITHUB_TOKEN_KEY] = "";
  }

  const ssh: SessionLaunchSpec["ssh"] = [];
  if (caps.some((c) => c.startsWith("ssh:"))) {
    for (const name of SSH_PRIVATE_KEY_FILES) {
      const content = deps.readFile(path.join(deps.sshDir, name));
      if (content === null) continue;
      const key = sshKeySecretKey(name);
      secretData[key] = content;
      ssh.push({ key, name });
    }
    if (ssh.length === 0) {
      log.warn(`[session-pod-launch] SSH granted to session ${req.id}, but no usable private key was found in ${deps.sshDir}/{${SSH_PRIVATE_KEY_FILES.join(",")}}`);
    }
  }

  // Empty slots for capabilities granted while the session runs (#3072); launch grants go in session.env.
  Object.assign(secretData, buildGrantedSecretData([], deps.readFile));

  const terminalToken = crypto.randomBytes(32).toString("hex");
  secretData[TERMINAL_TOKEN_KEY] = terminalToken;
  secretData[MCP_TOKEN_KEY] = mcpToken;

  const cloneEnv = await buildCloneEnv(cloneRepos, deps);
  if (cloneEnv) secretData[CLONE_ENV_KEY] = JSON.stringify(cloneEnv);

  const spec: SessionLaunchSpec = {
    sessionId: req.id,
    cwd,
    command: commandArgv,
    uploadDir: POD_UPLOAD_DIR,
    repos: specRepos,
    files,
    ...(hasEnvFile ? { envFileKey: SESSION_ENV_KEY } : {}),
    ssh,
    codexHome: POD_CODEX_HOME,
    ...(codexAuthKey ? { codexAuthKey } : {}),
    ...(isAgent && req.provider === "claude" ? {
      autoCompactIdleMs: SESSION_AUTO_COMPACT_IDLE_MS,
      // Skip Claude Code's first-run screens (#3131); Claws created these checkouts.
      claudeSetup: { theme: SESSION_POD_SETTINGS.claudeTheme, trustDirs: [...new Set([cwd, ...repoDirs.map(({ dir }) => dir)])] },
    } : {}),
    ...(SESSION_POD_SETTINGS.mcpUrl ? { exitReportUrl: sessionExitReportUrl(req.id) } : {}),
  };
  secretData[LAUNCH_SPEC_KEY] = JSON.stringify(spec);

  return { spec, secretData, cwd, repoDirs, terminalToken, mcpToken, hasGithubToken };
}
