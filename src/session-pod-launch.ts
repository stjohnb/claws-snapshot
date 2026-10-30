import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as log from "./log.js";
import { BROWSER_CDP_ENDPOINT, GIT_AUTHOR_EMAIL, GIT_AUTHOR_NAME, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, SESSION_AUTO_COMPACT_IDLE_MS, SESSION_POD_SETTINGS, forgejoRepoUrl } from "./config.js";
import {
  BROWSER_CAPABILITY_ID,
  ANTHROPIC_API_AUTH_CAPABILITY_ID,
  CLAUDE_AUTH_CAPABILITY_ID,
  CODEX_AUTH_CAPABILITY_ID,
  OPENROUTER_AUTH_CAPABILITY_ID,
  PAGES_CAPABILITY_ID,
  PI_AUTH_CAPABILITY_ID,
  buildCapabilityEnvArgs,
  grantedEnvVars,
  serviceCodexAuthPath,
  validCapabilityIds,
} from "./capabilities.js";
import { buildAgentArgv, sessionPromptText, type SessionMode, type SessionProvider } from "./sessions.js";
import {
  codexConfigBody,
  codexRemoteMcpServersToml,
  opencodeConfigBody,
  piRemoteMcpJson,
  renderGrantedEnvFile,
  renderSessionEnvFile,
  sessionPromptFileContent,
  type OpencodeRemoteMcpServer,
} from "./session-env-file.js";
import { buildEnvForForgejoGit, buildForgejoGitAuthEnv } from "./github-app.js";
import { OPENCODE_FULL_PERMISSIONS_CONFIG } from "./claude.js";
import { accountToken, pickClaudeAccount } from "./claude-accounts.js";
import { pickClaudeAccount as pickUnheldClaudeAccount, providerHoldsStale, refreshProviderHolds } from "./provider-holds.js";
import { piAuthJsonFromCodex, piCredentialEnv } from "./pi-auth.js";
import { pagesReadEnv } from "./pages-read-token.js";
import { PLAYWRIGHT_CDP_ENV_KEY, PLAYWRIGHT_MCP_PACKAGE, usesRemoteBrowser } from "./browser-endpoint.js";
import {
  CLONE_ENV_KEY,
  SSH_PRIVATE_KEY_FILES,
  SSH_SLOTS_KEY,
  sshKeySecretKey,
  GRANTED_ENV_KEY,
  LAUNCH_SPEC_KEY,
  MCP_TOKEN_KEY,
  TERMINAL_TOKEN_KEY,
  WORKLOAD_HOME,
} from "./k8s/workload.js";
import { SESSION_ENV_PATH, type SessionLaunchSpec } from "./session-pod/main.js";

// Builds what a `k8s-pod` session pod is launched from (#3026): the launch spec
// and the Secret data. Runs inside Claws. The Secret gets only what the
// session was granted — never `OPENAI_API_KEY` unless `pi-auth` is, the database URL/password or
// `INTERNAL_MCP_TOKEN` — and clone credentials go only to `clone-env.json`,
// which the pod builder projects into the init container alone.

/** Secret key of the session env file sourced by the argv prelude. */
export const SESSION_ENV_KEY = "session.env";
/** Secret key of the granted Codex `auth.json`. */
export const CODEX_AUTH_KEY = "codex-auth.json";
/** Secret key of the granted pi `auth.json` (the Codex login translated for pi). */
export const PI_AUTH_KEY = "pi-auth.json";
/** Claws-owned per-session state inside the pod's HOME. */
export const POD_SESSION_STATE_DIR = path.posix.join(WORKLOAD_HOME, ".claws-session");
export const POD_UPLOAD_DIR = path.posix.join(POD_SESSION_STATE_DIR, "uploads");
const POD_MCP_CONFIG_PATH = path.posix.join(POD_SESSION_STATE_DIR, "mcp.json");
/** Where the Claude system prompt is shipped (`files`, mode 0600), read by `--append-system-prompt-file` — see `buildAgentArgv` for why the prompt is a file, not argv (#clw_01M3HH9MM5J348FTZ4T9AY67Y2). */
export const POD_SYSTEM_PROMPT_PATH = path.posix.join(POD_SESSION_STATE_DIR, "system-prompt.md");
/**
 * Where the operator's dashboard Initial prompt is shipped (`files`, mode 0600)
 * for `INITIAL_PROMPT_PRELUDE` to read and delete — a file, not argv, because
 * tmux rejects a long `new-session` argv (#clw_01M3HH9MM5J348FTZ4T9AY67Y2).
 */
export const POD_INITIAL_PROMPT_PATH = path.posix.join(POD_SESSION_STATE_DIR, "initial-prompt.txt");
/**
 * `/bin/sh -c` prelude run as `… claws-initial-prompt <file> <prefix> <agent> <args…>`:
 * when `<file>` exists it reads it, deletes it and execs the agent with
 * `<prefix><prompt>` as one final argument; otherwise it execs the agent unchanged.
 * The prompt only ever passes through `cat` into `"$p"`, so no shell
 * metacharacter in it is interpreted.
 */
export const INITIAL_PROMPT_PRELUDE = 'if [ -f "$1" ]; then p=$(cat -- "$1"); rm -f -- "$1"; f=$2; shift 2; exec "$@" "$f$p"; fi; shift 2; exec "$@"';
const POD_OPENCODE_DIR = path.posix.join(POD_SESSION_STATE_DIR, "opencode");
const POD_CODEX_HOME = path.posix.join(WORKLOAD_HOME, ".codex");
/** pi's default `PI_CODING_AGENT_DIR` inside the pod. */
const POD_PI_AGENT_DIR = path.posix.join(WORKLOAD_HOME, ".pi", "agent");
const CLAWS_STATE_MCP_NAME = "claws-state";
const CODEX_SESSION_MCP_TOKEN_ENV = "CLAWS_SESSION_MCP_TOKEN";
const PI_SESSION_MCP_TOKEN_ENV = "PI_SESSION_MCP_TOKEN";

/** Where a repo is checked out inside the pod: `~/work/<owner>/<name>`. */
export function podRepoDir(fullName: string): string {
  return path.posix.join(WORKLOAD_HOME, "work", fullName);
}

export function podCloneUrl(fullName: string): string {
  return `${forgejoRepoUrl(fullName)}.git`;
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
  /** The row's issue brief (`PersistedSession.brief`), appended to the prompt on launch and resume; omitted or null for none. */
  brief?: string | null;
  /**
   * The operator's dashboard Initial prompt (`PersistedSession.initial_prompt`) while it is still undelivered; omitted
   * or null for none. Ignored for `repo-zsh`. When set, the agent starts fresh even on `resume`: it never began the
   * conversation `--continue` / `resume --last` would pick up.
   */
  initialPrompt?: string | null;
  /**
   * Files staged on the New Session form (`session-attachments.ts`) while the Initial prompt is still undelivered:
   * the pod fetches each from Claws into `POD_UPLOAD_DIR/<podName>` before the agent starts. Only the URLs and
   * names enter the launch spec, never the bytes.
   */
  attachments?: Array<{ id: string; podName: string; size: number }>;
  /**
   * The Claude account to run on (a switch, #clw_01M623AMK66JB6TBB4PP55Q2V6). Used when it has a token;
   * otherwise, or when omitted, one is picked as usual.
   */
  claudeAccountId?: string | null;
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
  /** The Claude account whose token went into `CLAUDE_CODE_OAUTH_TOKEN` / pi's Anthropic credential; null when none. */
  claudeAccountId: string | null;
}

export interface PodLaunchDeps {
  /** Reads a service-side file (Codex auth, SSH); null when absent. */
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
        env: buildEnvForForgejoGit(),
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
  readFile: readFileOrNull,
  sshDir: path.join(os.homedir(), ".ssh"),
  gitIdentity: serviceGitIdentity,
};

/**
 * The service's SSH private keys keyed by their Secret slot
 * (`sshKeySecretKey(name)`), for each `SSH_PRIVATE_KEY_FILES` entry present in
 * `deps.sshDir`. Every `ssh:*` host shares these keys.
 */
export function readServiceSshKeys(deps: Pick<PodLaunchDeps, "readFile" | "sshDir"> = defaultPodLaunchDeps): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const name of SSH_PRIVATE_KEY_FILES) {
    const content = deps.readFile(path.join(deps.sshDir, name));
    if (content !== null && content !== "") keys[sshKeySecretKey(name)] = content;
  }
  return keys;
}

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

/** Where the pod fetches one staged attachment from Claws, with its `claws-state` bearer token. */
function sessionAttachmentUrl(id: string, attachmentId: string): string {
  return `${SESSION_POD_SETTINGS.mcpUrl.replace(/\/+$/, "")}/api/sessions/${id}/attachments/${encodeURIComponent(attachmentId)}`;
}

/**
 * `~/.gitconfig` for a new session PVC (written only if absent, so the user's
 * later edits survive resume). Git identity only: Forgejo push access comes
 * from the `forgejo` capability's env.
 */
export function buildPodGitconfig(identity: { name?: string; email?: string }): string {
  const lines = [
    "# Written by Claws when this session's storage was created; never overwritten.",
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
function buildCloneEnv(repos: string[]): Record<string, string> | null {
  if (repos.length === 0) return null;
  const env = buildForgejoGitAuthEnv();
  if (!env.CLAWS_FORGEJO_GIT_TOKEN) {
    throw new Error(`Forgejo repo ${repos[0]} has no clone credential: CLAWS_FORGEJO_TOKEN is not configured`);
  }
  return env;
}

const GRANTED_ENV_HEADER = "# Capabilities granted mid-session are written here by Claws\n";

/**
 * The Secret slot for capabilities granted to a running pod session (#3072):
 * `granted-env`, always returned — empty of grants when `caps` is empty — so
 * the key exists from launch (the pod mounts only the keys listed at launch)
 * and one PATCH rewrites it. It exports the vars of every capability in `caps`
 * under a `grantedEnvMarker` line per capability so a reader can tell the
 * eventually-synced mount is current. A `pages` grant also carries the
 * session's derived pages read token (`pagesReadEnv`).
 */
export function buildGrantedSecretData(caps: string[], sessionId: string): Record<string, string> {
  const granted = validCapabilityIds(caps);
  const vars = grantedEnvVars(granted);
  if (granted.includes(PAGES_CAPABILITY_ID)) Object.assign(vars, pagesReadEnv(sessionId));
  return { [GRANTED_ENV_KEY]: GRANTED_ENV_HEADER + renderGrantedEnvFile(granted, vars) };
}

/**
 * Build the launch spec and Secret data for one pod launch. Throws when a
 * required credential is missing (e.g. no Forgejo clone token); callers treat
 * that as the runtime being unavailable.
 */
export async function buildPodLaunch(req: PodLaunchRequest, deps: PodLaunchDeps = defaultPodLaunchDeps): Promise<PodLaunch> {
  // The web tier launches sessions but runs no Reauth login: read the current
  // Claude accounts, tokens, holds and auth-expired latches from the database
  // so a fresh login or a just-set hold reaches this session with no restart.
  if (providerHoldsStale()) await refreshProviderHolds();
  const caps = validCapabilityIds(req.capabilities);
  const secretData: Record<string, string> = {};
  const files: SessionLaunchSpec["files"] = [];
  const isAgent = req.mode !== "repo-zsh";
  const command = isAgent ? req.provider : "zsh";
  const initialPrompt = isAgent && req.initialPrompt ? req.initialPrompt : null;
  const agentResume = req.resume && !initialPrompt;

  // ── Checkout layout ──
  const branch = req.mode === "worktree-claude" || req.mode === "multi-worktree-claude" ? `claws-wt/${req.id}` : undefined;
  const cloneRepos = req.mode === "home-claude" ? [] : req.repos;
  const repoDirs = cloneRepos.map((repo) => ({ repo, dir: podRepoDir(repo) }));
  const cwd = repoDirs[0]?.dir ?? WORKLOAD_HOME;
  const specRepos = repoDirs.map(({ repo, dir }) => ({ url: podCloneUrl(repo), dir, ...(branch ? { branch } : {}) }));

  // ── Session env file ──
  const vars = grantedEnvVars(caps);
  if (caps.includes(PAGES_CAPABILITY_ID)) Object.assign(vars, pagesReadEnv(req.id));
  // A session runs on one Claude account, shared by the Claude login and pi's
  // Anthropic credential: one that is not held or auth-expired, else the next
  // with a token so the session still gets one.
  // A switch names its account (#clw_01M623AMK66JB6TBB4PP55Q2V6); it is used while it has a token.
  const wantsClaude = caps.includes(CLAUDE_AUTH_CAPABILITY_ID) || caps.includes(PI_AUTH_CAPABILITY_ID);
  const requested = req.claudeAccountId && accountToken(req.claudeAccountId) ? { id: req.claudeAccountId } : null;
  const claudeAccount = wantsClaude ? requested ?? pickUnheldClaudeAccount() ?? pickClaudeAccount() : null;
  const claudeToken = claudeAccount ? accountToken(claudeAccount.id) : undefined;
  if (caps.includes(CLAUDE_AUTH_CAPABILITY_ID) && claudeToken) {
    vars.CLAUDE_CODE_OAUTH_TOKEN = claudeToken;
  }
  if (caps.includes(OPENROUTER_AUTH_CAPABILITY_ID) && OPENROUTER_API_KEY) {
    vars.OPENROUTER_API_KEY = OPENROUTER_API_KEY;
  }
  // OpenCode's anthropic/ models only; never in piCredentialEnv, so pi stays on the subscription token.
  if (req.provider === "opencode" && caps.includes(ANTHROPIC_API_AUTH_CAPABILITY_ID) && ANTHROPIC_API_KEY) {
    vars.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
  }
  // ANTHROPIC_OAUTH_TOKEN, OPENAI_API_KEY and OPENROUTER_API_KEY, each when set.
  if (caps.includes(PI_AUTH_CAPABILITY_ID)) Object.assign(vars, piCredentialEnv(claudeAccount?.id));

  // ── Agent files and argv ──
  // Agent pods with the claws-state server can call read-only diagnostics and claws_request_capability (#3072/#3172).
  // A browser pod holds claws-state too: the operator accepted the prompt-injection
  // risk of browsed pages reaching its write tools (#clw_01M4RASNVDKH2YBHZMGR0SM0RA).
  const includeClawsState = isAgent && !!SESSION_POD_SETTINGS.mcpUrl;
  const prompt = sessionPromptText(
    caps,
    includeClawsState ? { backend: "k8s-pod", provider: req.provider, mode: req.mode } : undefined,
    req.brief,
  );
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
      files.push({ path: POD_SYSTEM_PROMPT_PATH, content: sessionPromptFileContent(prompt) });
      agentArgs = buildAgentArgv({
        provider: "claude",
        promptFile: POD_SYSTEM_PROMPT_PATH,
        uploadDir: POD_UPLOAD_DIR,
        mcpConfigPath: POD_MCP_CONFIG_PATH,
        extra: agentResume ? ["--continue", ...addDirArgs] : addDirArgs,
        model: req.model,
        initialPrompt: initialPrompt !== null,
      });
    } else if (req.provider === "codex") {
      const mcpServersToml = clawsState
        ? codexRemoteMcpServersToml(CLAWS_STATE_MCP_NAME, clawsState.url, CODEX_SESSION_MCP_TOKEN_ENV)
        : "";
      if (clawsState) vars[CODEX_SESSION_MCP_TOKEN_ENV] = mcpToken;
      files.push({ path: path.posix.join(POD_CODEX_HOME, "config.toml"), content: codexConfigBody(prompt, mcpServersToml) });
      agentArgs = buildAgentArgv({
        provider: "codex",
        promptFile: null,
        uploadDir: POD_UPLOAD_DIR,
        mcpConfigPath: null,
        extra: addDirArgs,
        resume: agentResume,
        model: req.model,
        initialPrompt: initialPrompt !== null,
      });
    } else if (req.provider === "pi") {
      // pi reads mcp.json and APPEND_SYSTEM.md from its agent dir; it expands
      // `${VAR}` in headers, so the bearer token stays in the env file.
      if (clawsState) {
        files.push({ path: path.posix.join(POD_PI_AGENT_DIR, "mcp.json"), content: piRemoteMcpJson(CLAWS_STATE_MCP_NAME, clawsState.url, PI_SESSION_MCP_TOKEN_ENV) });
        vars[PI_SESSION_MCP_TOKEN_ENV] = mcpToken;
      } else {
        files.push({ path: path.posix.join(POD_PI_AGENT_DIR, "mcp.json"), content: JSON.stringify({ mcpServers: {} }) });
      }
      files.push({ path: path.posix.join(POD_PI_AGENT_DIR, "APPEND_SYSTEM.md"), content: sessionPromptFileContent(prompt) });
      vars.PI_SKIP_VERSION_CHECK = "1";
      vars.PI_TELEMETRY = "0";
      agentArgs = buildAgentArgv({
        provider: "pi",
        promptFile: null,
        uploadDir: POD_UPLOAD_DIR,
        mcpConfigPath: null,
        extra: [],
        resume: agentResume,
        model: req.model,
        initialPrompt: initialPrompt !== null,
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
        promptFile: null,
        uploadDir: POD_UPLOAD_DIR,
        mcpConfigPath: null,
        extra: [],
        resume: agentResume,
        model: req.model,
        initialPrompt: initialPrompt !== null,
      });
    }
  }
  // The operator's Initial prompt: one final agent argument, read from a file by the prelude below.
  let initialPromptArgs: string[] = [];
  if (initialPrompt !== null) {
    files.push({ path: POD_INITIAL_PROMPT_PATH, content: initialPrompt, mode: 0o600 });
    // opencode takes it as `--prompt=`; pi reads an `@`-led argument as a file even after `--`.
    const prefix = req.provider === "opencode" ? "--prompt=" : req.provider === "pi" && initialPrompt.startsWith("@") ? " " : "";
    initialPromptArgs = ["/bin/sh", "-c", INITIAL_PROMPT_PRELUDE, "claws-initial-prompt", POD_INITIAL_PROMPT_PATH, prefix];
  }
  files.push({ path: path.posix.join(WORKLOAD_HOME, ".gitconfig"), content: buildPodGitconfig(await deps.gitIdentity()), onlyIfAbsent: true });

  const hasEnvFile = Object.keys(vars).length > 0;
  if (hasEnvFile) secretData[SESSION_ENV_KEY] = renderSessionEnvFile(vars);
  const commandArgv = [...buildCapabilityEnvArgs(caps, hasEnvFile ? SESSION_ENV_PATH : null), ...initialPromptArgs, command, ...agentArgs];

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
  let piAuthKey: string | undefined;
  if (caps.includes(PI_AUTH_CAPABILITY_ID)) {
    const auth = piAuthJsonFromCodex(serviceCodexAuthPath());
    if (auth !== null) {
      secretData[PI_AUTH_KEY] = auth;
      piAuthKey = PI_AUTH_KEY;
    }
  }

  // Both SSH slots exist from launch, empty without an ssh:* grant, so a
  // mid-session grant can fill them and a revoke can empty them: the pod mounts
  // only launch-time keys and polls the slots.
  const ssh: SessionLaunchSpec["ssh"] = SSH_PRIVATE_KEY_FILES.map((name) => ({ key: sshKeySecretKey(name), name }));
  for (const { key } of ssh) secretData[key] = "";
  secretData[SSH_SLOTS_KEY] = "1";
  if (caps.some((c) => c.startsWith("ssh:"))) {
    const keys = readServiceSshKeys(deps);
    if (Object.keys(keys).length === 0) {
      log.warn(`[session-pod-launch] SSH granted to session ${req.id}, but no usable private key was found in ${deps.sshDir}/{${SSH_PRIVATE_KEY_FILES.join(",")}}`);
    }
    Object.assign(secretData, keys);
  }

  // Empty slots for capabilities granted while the session runs (#3072); launch grants go in session.env.
  Object.assign(secretData, buildGrantedSecretData([], req.id));

  const terminalToken = crypto.randomBytes(32).toString("hex");
  secretData[TERMINAL_TOKEN_KEY] = terminalToken;
  secretData[MCP_TOKEN_KEY] = mcpToken;

  const attachments = isAgent ? req.attachments ?? [] : [];
  if (attachments.length > 0 && !SESSION_POD_SETTINGS.mcpUrl) {
    throw new Error("attached files need CLAWS_SESSION_MCP_URL, which the pod fetches them from");
  }

  const cloneEnv = buildCloneEnv(cloneRepos);
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
    ...(piAuthKey ? { piAuthKey } : {}),
    ...(isAgent && req.provider === "claude" ? {
      autoCompactIdleMs: SESSION_AUTO_COMPACT_IDLE_MS,
      // Skip Claude Code's first-run screens (#3131); Claws created these checkouts.
      claudeSetup: { theme: SESSION_POD_SETTINGS.claudeTheme, trustDirs: [...new Set([cwd, ...repoDirs.map(({ dir }) => dir)])] },
    } : {}),
    ...(SESSION_POD_SETTINGS.mcpUrl ? { exitReportUrl: sessionExitReportUrl(req.id) } : {}),
    attachments: attachments.map((a) => ({ url: sessionAttachmentUrl(req.id, a.id), name: a.podName, size: a.size })),
  };
  secretData[LAUNCH_SPEC_KEY] = JSON.stringify(spec);

  return { spec, secretData, cwd, repoDirs, terminalToken, mcpToken, claudeAccountId: claudeToken ? claudeAccount!.id : null };
}
