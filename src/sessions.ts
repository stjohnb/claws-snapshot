import * as pty from "node-pty";
import { spawn as childSpawn } from "node:child_process";
import * as log from "./log.js";
import { isShuttingDown } from "./shutdown.js";
import { WORK_DIR, OPENCODE_BEST_MODEL, OPENROUTER_API_KEY } from "./config.js";
import * as claude from "./claude.js";
import { listRepos } from "./github.js";
import {
  BROWSER_CAPABILITY_ID,
  buildCapabilityEnvArgs,
  buildCapabilityPrompt,
  resolveCapabilityEnv,
  withImplicitCapabilities,
} from "./capabilities.js";
import { SESSION_WORKFLOW_PROMPT } from "./resources/claws-info.js";
import {
  writeSessionEnvFile,
  removeSessionEnvFile,
  pruneSessionEnvFiles,
  ensureSessionMcpDir,
  ensureSessionCodexHome,
  ensureSessionOpencodeConfig,
  pruneOrphanSessionMcpDirs,
  removeSessionMcpDir,
} from "./session-env-file.js";
import {
  ensureSessionUploadDir,
  pruneOrphanSessionUploadDirs,
  removeSessionUploadDir,
} from "./session-uploads.js";
import type { Repo } from "./config.js";
import {
  insertSession,
  getAllPersistedSessions,
  deletePersistedSession,
  updateSessionSummary,
  setManualSessionSummary,
  getEndedSessions,
  getPersistedSession,
  markSessionEnded,
  clearSessionEnded,
  pruneEndedSessions,
  type PersistedSession,
} from "./db.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { stripVTControlCharacters } from "node:util";

const TMUX_SOCKET = "claws";
const SESSION_NAME_PREFIX = "claws-";
const SCROLLBACK_LIMIT = 50_000;
const MAX_RESPAWN_ATTEMPTS = 3;
const RESPAWN_MIN_LIFETIME_MS = 500;
const MAX_ENDED_SESSIONS = 50;

export const SESSION_MODES = ["repo-zsh", "repo-claude", "worktree-claude", "home-claude", "multi-worktree-claude"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/** Agent CLI a session runs. Persisted per session; NULL rows predate #2664 and mean `"claude"`. */
export const SESSION_PROVIDERS = ["claude", "codex", "opencode"] as const;
export type SessionProvider = (typeof SESSION_PROVIDERS)[number];

/** Coerce a persisted `provider` column (NULL on pre-#2664 rows) into a SessionProvider. */
function providerFromRow(raw: string | null | undefined): SessionProvider {
  if (raw === "codex") return "codex";
  if (raw === "opencode") return "opencode";
  return "claude";
}

export interface Session {
  id: string;
  pty: pty.IPty;
  tmuxName: string;
  createdAt: number;
  lastActivity: number;
  repo: string | null;
  cwd: string;
  mode: SessionMode;
  provider: SessionProvider;
  /** Operator-chosen model id, or null for the provider default (#2873). */
  model: string | null;
  worktreePath: string | null;
  extraWorktrees: Array<{ repo: string; worktreePath: string }>;
  capabilities: string[];
  scrollback: string;
  alive: boolean;
  exitCode: number | null;
  wsConnected: boolean;
  bridgeSpawnedAt: number;
  respawnCount: number;
  resumable: boolean;
  resumeRepos: string[];
  summary: string | null;
  summaryUpdatedAt: number | null;
  summaryManual: boolean;
}

export type CreateSessionError =
  | "shutting-down"
  | "too-few-repos"
  | "repo-required-for-mode"
  | "capability-unsupported"
  | "not-resumable"
  | "repo-not-found"
  | "repo-not-listed"
  | "fetch-failed"
  | "worktree-failed"
  | "tmux-failed"
  | "bridge-failed"
  | "persist-failed";

export type CreateSessionResult =
  | { ok: true; session: Session }
  | { ok: false; reason: CreateSessionError; detail?: string };

export function describeCreateSessionError(err: { reason: CreateSessionError; detail?: string }): string {
  switch (err.reason) {
    case "shutting-down": return "Server is shutting down";
    case "too-few-repos": return "Select at least two repos for a multi-repo session";
    case "repo-required-for-mode": return "This mode requires a repo to be selected";
    case "capability-unsupported": return `Capability not supported by this agent${err.detail ? `: ${err.detail}` : ""}`;
    case "not-resumable": return `Session is not resumable${err.detail ? `: ${err.detail}` : ""}`;
    case "repo-not-found": return `Repo not found${err.detail ? `: ${err.detail}` : ""}`;
    case "repo-not-listed": return `Repo is not in the configured repo list${err.detail ? `: ${err.detail}` : ""}`;
    case "fetch-failed": return `Failed to fetch latest changes from GitHub${err.detail ? `: ${err.detail}` : ""}`;
    case "worktree-failed": return `Failed to create worktree${err.detail ? `: ${err.detail}` : ""}`;
    case "tmux-failed": return `tmux failed to start the session${err.detail ? `: ${err.detail}` : ""}`;
    case "bridge-failed": return `Failed to attach to tmux session${err.detail ? `: ${err.detail}` : ""}`;
    case "persist-failed": return `Failed to persist session${err.detail ? `: ${err.detail}` : ""}`;
  }
}

const sessions = new Map<string, Session>();

async function tmuxCmd(args: string[], socket: string | null = TMUX_SOCKET): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const sockArgs = socket ? ["-L", socket] : [];
    const proc = childSpawn("tmux", [...sockArgs, ...args]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    proc.on("error", () => resolve({ code: 1, stdout, stderr }));
  });
}

async function tmuxSessionExists(name: string): Promise<boolean> {
  const r = await tmuxCmd(["has-session", "-t", `=${name}`]);
  return r.code === 0;
}

async function tmuxListSessions(): Promise<Set<string>> {
  const r = await tmuxCmd(["list-sessions", "-F", "#{session_name}"]);
  if (r.code !== 0) return new Set();
  return new Set(r.stdout.split("\n").filter(Boolean));
}

async function tmuxListSessionsOnDefaultSocket(): Promise<Set<string>> {
  const r = await tmuxCmd(["list-sessions", "-F", "#{session_name}"], null);
  if (r.code !== 0) return new Set();
  return new Set(r.stdout.split("\n").filter(Boolean));
}

async function tmuxCapturePane(name: string): Promise<string> {
  const r = await tmuxCmd(["capture-pane", "-p", "-S", "-10000", "-t", `=${name}:`]);
  return r.code === 0 ? r.stdout : "";
}

async function tmuxKillSession(name: string): Promise<void> {
  await tmuxCmd(["kill-session", "-t", `=${name}`]);
}

// Options applied to every Claws tmux session. `mouse on` gives drag-select and
// wheel scroll inside tmux; `set-clipboard on` makes tmux emit OSC 52 to the
// attached bridge when copy-mode copies, which the browser terminal turns into a
// real clipboard write (tmux's default `external` only passes an inner app's
// OSC 52 through — it never sends one for tmux's own copy-mode selection).
// `set-clipboard` is a tmux *server* option, so `-t` is ignored and one call
// covers every session on the socket; it is still re-applied per session because
// the tmux server exits with its last session and a fresh server loses it.
async function applySessionTmuxOptions(tmuxName: string): Promise<void> {
  for (const [name, value] of [["mouse", "on"], ["set-clipboard", "on"]] as const) {
    const res = await tmuxCmd(["set-option", "-t", `=${tmuxName}`, name, value]);
    if (res.code !== 0) {
      log.warn(`[sessions] Failed to set tmux ${name}=${value} for ${tmuxName}: ${res.stderr.trim()}`);
    }
  }
}

function spawnBridge(tmuxName: string, cwd: string): pty.IPty {
  return pty.spawn("tmux", ["-L", TMUX_SOCKET, "attach-session", "-t", `=${tmuxName}`], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd,
    env: { ...process.env, TERM: "xterm-256color" },
  });
}

const OSC52_START = "\x1b]52;";
// Give up holding an unterminated OSC 52 after this much, so a malformed
// sequence cannot pin the whole stream in memory.
const OSC52_MAX_HOLD = 4_000_000;

/**
 * Remove OSC 52 clipboard sequences from a pty chunk before it is appended to
 * `session.scrollback`. The live WebSocket stream still carries them (the client
 * decodes them into the browser clipboard); the *buffer* must not, because it is
 * replayed verbatim on every reconnect — replaying a copy would silently
 * overwrite the user's clipboard — and because a base64 payload would blow the
 * 50 KB budget that also feeds summarizeSession().
 *
 * `carry` holds a partial sequence spanning chunk boundaries; pass "" first and
 * thread the returned value through subsequent calls.
 */
export function stripOsc52(chunk: string, carry: string): { clean: string; carry: string } {
  const buf = carry + chunk;
  let out = "";
  let i = 0;
  for (;;) {
    const idx = buf.indexOf(OSC52_START, i);
    if (idx === -1) {
      // Hold back any trailing bytes that could be the start of the marker.
      let hold = 0;
      for (let n = Math.min(OSC52_START.length - 1, buf.length - i); n > 0; n--) {
        if (buf.endsWith(OSC52_START.slice(0, n))) { hold = n; break; }
      }
      out += buf.slice(i, buf.length - hold);
      return { clean: out, carry: buf.slice(buf.length - hold) };
    }
    out += buf.slice(i, idx);
    const from = idx + OSC52_START.length;
    const bel = buf.indexOf("\x07", from);
    const st = buf.indexOf("\x1b\\", from);
    const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
    if (end === -1) {
      if (buf.length - idx > OSC52_MAX_HOLD) return { clean: out + buf.slice(idx), carry: "" };
      return { clean: out, carry: buf.slice(idx) };
    }
    i = end + (end === bel ? 1 : 2);
  }
}

function wireBridgeHandlers(session: Session): void {
  let osc52Carry = "";
  session.pty.onData((data: string) => {
    session.lastActivity = Date.now();
    const { clean, carry } = stripOsc52(data, osc52Carry);
    osc52Carry = carry;
    session.scrollback += clean;
    if (session.scrollback.length > SCROLLBACK_LIMIT) {
      session.scrollback = session.scrollback.slice(-SCROLLBACK_LIMIT);
    }
  });
  session.pty.onExit(({ exitCode }) => handleBridgeExit(session, exitCode));
}

function handleBridgeExit(session: Session, exitCode: number): void {
  session.exitCode = exitCode;
  void tmuxSessionExists(session.tmuxName).then((exists) => {
    if (!sessions.has(session.id)) return;
    if (!exists) {
      session.alive = false;
      session.resumable = true;
      void recordSessionEnded(session);   // reads extraWorktrees synchronously → must run BEFORE cleanup
      log.info(`[sessions] Session ${session.id} exited (code ${exitCode}) — moved to history`);
      void cleanupSessionWorktree(session);
      sessions.delete(session.id);
      return;
    }
    if (isShuttingDown()) return;

    const lifetime = Date.now() - session.bridgeSpawnedAt;
    if (lifetime < RESPAWN_MIN_LIFETIME_MS) {
      session.respawnCount += 1;
      if (session.respawnCount >= MAX_RESPAWN_ATTEMPTS) {
        session.alive = false;
        log.error(`[sessions] Session ${session.id} bridge failed to stay up after ${MAX_RESPAWN_ATTEMPTS} attempts — giving up`);
        void teardownNonResumableSession(session.id, session.tmuxName, drainSessionWorktrees(session));
        return;
      }
    } else {
      session.respawnCount = 0;
    }

    log.info(`[sessions] Session ${session.id} bridge exited but tmux persists — respawning bridge`);
    try {
      session.pty = spawnBridge(session.tmuxName, session.cwd);
      session.bridgeSpawnedAt = Date.now();
      wireBridgeHandlers(session);
    } catch (err) {
      session.alive = false;
      log.error(`[sessions] Session ${session.id} failed to respawn bridge: ${err}`);
      void teardownNonResumableSession(session.id, session.tmuxName, drainSessionWorktrees(session));
    }
  });
}

/** The Claws workflow text every session is given, plus a block describing granted capabilities. */
function sessionPromptText(caps: string[]): string {
  return [SESSION_WORKFLOW_PROMPT, buildCapabilityPrompt(caps)]
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}

/**
 * Build the argv passed to the agent CLI for a session spawn. Always disables
 * permission prompts; always carries the session prompt — SESSION_WORKFLOW_PROMPT
 * (so the session follows the Claws issue/PR lifecycle instead of invoking the
 * repo's `.agents/*` role documents, see #2360) plus, when at least one
 * capability was granted, a capability-awareness block — guarded against an
 * empty string so a dangling flag never consumes the next argv; also wires the
 * session's upload dir via `--add-dir` so drag-and-drop uploads are readable,
 * but a failed mkdir is logged and skipped rather than failing the spawn — an
 * upload-less session is still fully usable.
 *
 * Provider differences: `claude` injects the prompt via `--append-system-prompt`
 * and always runs with a Claws-owned `--mcp-config --strict-mcp-config`; plain
 * sessions include `claws-state`, while `browser` sessions stay Playwright-only
 * and deliberately exclude `claws-state`. `codex` has no Claws MCP integration
 * and rejects `browser`, but the workflow/capability prompt is delivered via
 * session-local `CODEX_HOME/config.toml` `developer_instructions`. Codex
 * positional prompts are deliberately not used: they submit the startup context
 * as the first user request and make sessions act before the human has typed.
 * On a codex resume (`resume === true`), `resume --last` uses the same
 * session-owned `CODEX_HOME`, so the guidance remains available without being
 * re-submitted as a user message. `opencode` also has no MCP integration, no
 * `--add-dir` and no system-prompt flag — the upload dir is still created so
 * drag-and-drop works, but the file path is typed into the TUI. The session
 * runs with full permissions via `OPENCODE_CONFIG_CONTENT` (#2875), so the
 * `external_directory`/`doom_loop` prompts no longer appear — and the
 * browser capability is rejected the same way as codex. Its argv carries only
 * `--model` from `opencodeBestModel` plus `--continue` on resume: the
 * workflow prompt is delivered as system-prompt context through a
 * session-local `OPENCODE_CONFIG` `instructions` file written by
 * `capabilityEnvArgs`, because `--prompt` submitted the text as a first user
 * message and made sessions start working instead of waiting for input
 * (#2866).
 *
 * `model` is the operator's per-session model choice from the New Session form
 * (#2873); `null`/empty means "provider default" — no `--model` for claude and
 * codex, `opencodeBestModel` for opencode. Claude choices are the CLI's tier
 * aliases (`opus`/`sonnet`/…), which resolve to the newest model in that tier.
 * On a **codex resume** `--model` is deliberately NOT re-passed: `codex resume
 * --last` restores the model recorded in the rollout file, and stacking a
 * global flag onto the `resume` subcommand risks the CLI rejecting the argv and
 * the tmux window dying instantly with no visible error. opencode gets it on
 * resume too, since `--continue` does not restore a model.
 */
function agentShellArgs(
  sessionId: string,
  provider: SessionProvider,
  caps: string[],
  extra: string[],
  resume = false,
  model: string | null = null,
): string[] {
  const prompt = sessionPromptText(caps);
  const promptArgs = prompt ? ["--append-system-prompt", prompt] : [];
  let uploadArgs: string[] = [];
  try {
    uploadArgs = ["--add-dir", ensureSessionUploadDir(sessionId)];
  } catch (err) {
    log.warn(`[sessions] Failed to create upload dir for ${sessionId}: ${err}`);
  }

  if (provider === "codex") {
    const leading = resume ? ["resume", "--last"] : [];
    // Deliberately no `--model` on resume: `codex resume --last` restores the
    // model recorded in the rollout file, and stacking a global flag onto the
    // `resume` subcommand is the risky path (#2873).
    const modelArgs = !resume && model ? ["--model", model] : [];
    return [...leading, "--dangerously-bypass-approvals-and-sandbox", ...modelArgs, ...uploadArgs, ...extra];
  }

  if (provider === "opencode") {
    // opencode's TUI has no --add-dir and no --mcp-config: `uploadArgs` and the
    // caller's `extra` (claude/codex --add-dir pairs) are deliberately dropped.
    // The workflow prompt is NOT passed here: opencode's `--prompt` submits it
    // as the first *user* message, which made every session launch straight
    // into looking for work rather than waiting for the human (#2866). It is
    // delivered as system-prompt context instead, via the session-local
    // `OPENCODE_CONFIG` written in `capabilityEnvArgs` — which also means it
    // still applies on a `--continue` resume.
    const chosenModel = model || OPENCODE_BEST_MODEL;
    const modelArgs = chosenModel ? ["--model", chosenModel] : [];
    const leading = resume ? ["--continue"] : [];
    return [...leading, ...modelArgs];
  }

  const dir = ensureSessionMcpDir(sessionId);
  const includeBrowser = caps.includes(BROWSER_CAPABILITY_ID);
  const configPath = claude.writeClawsMcpConfig(dir, {
    sessionId,
    includeClawsState: !includeBrowser,
    additionalServers: includeBrowser
      ? {
          playwright: {
            command: "npx",
            args: [
              "@playwright/mcp@latest",
              "--headless",
              "--user-data-dir",
              path.join(dir, "browser-profile"),
            ],
          },
        }
      : undefined,
  });
  const mcpArgs = ["--mcp-config", configPath, "--strict-mcp-config"];

  const modelArgs = model ? ["--model", model] : [];
  return ["--dangerously-skip-permissions", ...modelArgs, ...promptArgs, ...uploadArgs, ...mcpArgs, ...extra];
}

/**
 * Resolve the capability grant into an `env`-prefix argv. Granted values are
 * written to a 0600 file sourced by a /bin/sh prelude — never placed on argv,
 * which is world-readable via /proc/<pid>/cmdline (#2138). Throws if the file
 * cannot be written; callers must treat that as a failed spawn.
 */
function capabilityEnvArgs(
  sessionId: string,
  caps: string[],
  provider: SessionProvider,
  command: string,
): string[] {
  const { vars } = resolveCapabilityEnv(caps);
  const sessionVars = { ...vars };
  if (provider === "codex" && command === "codex") {
    sessionVars.CODEX_HOME = ensureSessionCodexHome(sessionId, sessionPromptText(caps));
  }
  if (provider === "opencode" && command === "opencode") {
    // tmux spawns from the tmux server's env, which lacks ~/.opencode/bin;
    // enrichedPath() prepends the well-known installer dirs that exist.
    sessionVars.PATH = claude.enrichedPath(process.env["PATH"]);
    // OPENROUTER_API_KEY is in SENSITIVE_ENV_KEYS and is therefore `env -u`'d
    // from every session; re-grant it out-of-band via the 0600 env file when
    // configured. opencode's own ~/.local/share/opencode/auth.json is the
    // fallback when it is empty.
    if (OPENROUTER_API_KEY) sessionVars.OPENROUTER_API_KEY = OPENROUTER_API_KEY;
    sessionVars.OPENCODE_CONFIG = ensureSessionOpencodeConfig(sessionId, sessionPromptText(caps));
    // The TUI has no permission flag; grant full permissions through inline
    // config, which merges over (and outranks) the OPENCODE_CONFIG file and
    // the worked-on repo's own opencode.json (#2875).
    sessionVars.OPENCODE_CONFIG_CONTENT = claude.OPENCODE_FULL_PERMISSIONS_CONFIG;
  }
  const envFilePath = Object.keys(sessionVars).length > 0 ? writeSessionEnvFile(sessionId, sessionVars) : null;
  return buildCapabilityEnvArgs(caps, envFilePath);
}

export async function createSession(
  repo: string | null,
  mode: SessionMode,
  capabilities: string[] = [],
  provider: SessionProvider = "claude",
  model: string | null = null,
): Promise<CreateSessionResult> {
  if (isShuttingDown()) return { ok: false, reason: "shutting-down" };

  // A `repo-zsh` session runs `zsh`, not an agent CLI; the New Session form
  // disables the Agent select for this mode. Normalise anything else a caller
  // posts rather than persisting — and later displaying — a provider the
  // session never launched (#2786).
  const effectiveProvider: SessionProvider = mode === "repo-zsh" ? "claude" : provider;
  // Same reasoning for the model choice: a zsh session runs no CLI, so never
  // persist a model for it (#2873).
  const effectiveModel = mode === "repo-zsh" ? null : (model && model.trim() ? model.trim() : null);

  // The browser capability is delivered as a Playwright `--mcp-config`, which
  // codex and opencode have no equivalent for (per-run `mcp_servers.*` config
  // would put the MCP token on argv, #2138). Reject rather than silently
  // dropping the grant.
  if (mode !== "repo-zsh" && provider !== "claude" && capabilities.includes(BROWSER_CAPABILITY_ID)) {
    log.warn(`[sessions] Rejected: ${provider} sessions cannot be granted the ${BROWSER_CAPABILITY_ID} capability`);
    return { ok: false, reason: "capability-unsupported", detail: `${provider} cannot use the ${BROWSER_CAPABILITY_ID} capability` };
  }

  // A Forgejo-hosted repo has no forge credential of any kind without this
  // (#2871) — granted automatically rather than offered as a checkbox.
  const effectiveCaps = withImplicitCapabilities(capabilities, [repo]);

  if (mode === "multi-worktree-claude") {
    // Multi-repo sessions must be created via createMultiWorktreeSession.
    return { ok: false, reason: "repo-required-for-mode" };
  }

  if (!repo && (mode === "worktree-claude" || mode === "repo-claude")) {
    log.warn(`[sessions] Rejected: mode=${mode} requires a repo`);
    return { ok: false, reason: "repo-required-for-mode" };
  }

  const id = crypto.randomBytes(8).toString("hex");

  let cwd: string;
  let worktreePath: string | null = null;

  if (!repo || mode === "home-claude") {
    cwd = os.homedir();
  } else {
    const reposBase = path.join(WORK_DIR, "repos");
    const mainClone = path.resolve(reposBase, repo);
    if (!mainClone.startsWith(reposBase + path.sep) || !fs.existsSync(mainClone)) {
      log.warn(`[sessions] Rejected: repo path does not exist: ${repo}`);
      return { ok: false, reason: "repo-not-found", detail: repo ?? undefined };
    }

    const repoObj = (await listRepos().catch(() => [] as Repo[]))
      .find((r) => r.fullName === repo);
    if (!repoObj) {
      log.warn(`[sessions] Rejected: repo not in listRepos(): ${repo}`);
      return { ok: false, reason: "repo-not-listed", detail: repo ?? undefined };
    }

    try {
      await claude.ensureClone(repoObj);
    } catch (err) {
      log.warn(`[sessions] Failed to refresh ${repo} before session: ${err}`);
      return { ok: false, reason: "fetch-failed", detail: String(err) };
    }

    if (mode === "worktree-claude") {
      const branchName = `claws-wt/${id}`;
      try {
        worktreePath = await claude.createWorktree(repoObj, branchName, "sessions");
      } catch (err) {
        log.warn(`[sessions] Failed to create session worktree for ${repo}: ${err}`);
        return { ok: false, reason: "worktree-failed", detail: String(err) };
      }
      cwd = worktreePath;
    } else {
      cwd = mainClone;
    }
  }

  const tmuxName = `claws-${id}`;
  const command = mode === "repo-zsh" ? "zsh" : effectiveProvider;
  let envArgs: string[];
  let shellArgs: string[];
  try {
    envArgs = capabilityEnvArgs(id, effectiveCaps, effectiveProvider, command);
    shellArgs = mode === "repo-zsh" ? [] : agentShellArgs(id, effectiveProvider, effectiveCaps, [], false, effectiveModel);
  } catch (err) {
    log.warn(`[sessions] Failed to prepare session runtime for ${id}: ${err}`);
    await cleanupFailedSessionCreate(
      id,
      worktreePath && repo ? [{ repo, worktreePath }] : [],
    );
    return { ok: false, reason: "tmux-failed", detail: String(err) };
  }

  const createRes = await tmuxCmd([
    "new-session", "-d", "-s", tmuxName,
    "-x", "120", "-y", "40",
    "-c", cwd,
    ...envArgs, command, ...shellArgs,
  ]);
  if (createRes.code !== 0) {
    log.warn(`[sessions] tmux new-session failed: ${createRes.stderr.trim()}`);
    await cleanupFailedSessionCreate(
      id,
      worktreePath && repo ? [{ repo, worktreePath }] : [],
    );
    return { ok: false, reason: "tmux-failed", detail: createRes.stderr.trim() };
  }

  await applySessionTmuxOptions(tmuxName);

  let proc: pty.IPty;
  try {
    proc = spawnBridge(tmuxName, cwd);
  } catch (err) {
    log.warn(`[sessions] Failed to attach bridge to tmux session ${tmuxName}: ${err}`);
    await tmuxKillSession(tmuxName);
    await cleanupFailedSessionCreate(
      id,
      worktreePath && repo ? [{ repo, worktreePath }] : [],
    );
    return { ok: false, reason: "bridge-failed", detail: String(err) };
  }

  try {
    await insertSession({
      id,
      tmux_name: tmuxName,
      mode,
      repo,
      cwd,
      worktree_path: worktreePath,
      extra_worktrees: null,
      capabilities: JSON.stringify(effectiveCaps),
      created_at: Date.now(),
      summary: null,
      summary_updated_at: null,
      provider: effectiveProvider,
      model: effectiveModel,
    });
  } catch (err) {
    log.error(`[sessions] Failed to persist session ${id}: ${err}`);
    proc.kill();
    await tmuxKillSession(tmuxName);
    await cleanupFailedSessionCreate(
      id,
      worktreePath && repo ? [{ repo, worktreePath }] : [],
    );
    return { ok: false, reason: "persist-failed", detail: String(err) };
  }

  const session: Session = {
    id,
    pty: proc,
    tmuxName,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    repo,
    cwd,
    mode,
    provider: effectiveProvider,
    model: effectiveModel,
    worktreePath,
    extraWorktrees: [],
    capabilities: effectiveCaps,
    scrollback: "",
    alive: true,
    exitCode: null,
    wsConnected: false,
    bridgeSpawnedAt: Date.now(),
    respawnCount: 0,
    resumable: false,
    resumeRepos: [],
    summary: null,
    summaryUpdatedAt: null,
    summaryManual: false,
  };

  wireBridgeHandlers(session);

  sessions.set(id, session);
  log.info(`[sessions] Created session ${id} (cwd: ${cwd}, mode: ${mode}, provider: ${effectiveProvider}, model: ${effectiveModel ?? "default"}, tmux: ${tmuxName})`);
  return { ok: true, session };
}

/**
 * Launch a Claude session wired to a fresh worktree for each of `repos`.
 * Claude runs with its cwd set to the first repo's worktree; the remaining
 * worktrees are passed via `--add-dir` so it can read/write across all of them.
 */
export async function createMultiWorktreeSession(repos: string[], capabilities: string[] = [], model: string | null = null): Promise<CreateSessionResult> {
  if (isShuttingDown()) return { ok: false, reason: "shutting-down" };

  const effectiveModel = model && model.trim() ? model.trim() : null;

  const deduped: string[] = [];
  for (const r of repos) {
    if (r && !deduped.includes(r)) deduped.push(r);
  }
  if (deduped.length < 2) return { ok: false, reason: "too-few-repos" };

  // One Forgejo repo anywhere in the set grants the forgejo capability (#2871).
  const effectiveCaps = withImplicitCapabilities(capabilities, deduped);

  const id = crypto.randomBytes(8).toString("hex");
  const reposBase = path.join(WORK_DIR, "repos");
  const allRepos = await listRepos().catch(() => [] as Repo[]);

  // Resolve every repo up front so we don't create worktrees for a batch that
  // contains an invalid entry.
  const resolved: Repo[] = [];
  for (const repo of deduped) {
    const mainClone = path.resolve(reposBase, repo);
    if (!mainClone.startsWith(reposBase + path.sep) || !fs.existsSync(mainClone)) {
      log.warn(`[sessions] Rejected multi-repo session: repo path does not exist: ${repo}`);
      return { ok: false, reason: "repo-not-found", detail: repo };
    }
    const repoObj = allRepos.find((r) => r.fullName === repo);
    if (!repoObj) {
      log.warn(`[sessions] Rejected multi-repo session: repo not in listRepos(): ${repo}`);
      return { ok: false, reason: "repo-not-listed", detail: repo };
    }
    resolved.push(repoObj);
  }

  const created: Array<{ repo: string; worktreePath: string }> = [];
  for (const repoObj of resolved) {
    try {
      await claude.ensureClone(repoObj);
    } catch (err) {
      log.warn(`[sessions] Failed to refresh ${repoObj.fullName} before multi-repo session: ${err}`);
      await removeWorktreesByRepo(created);
      return { ok: false, reason: "fetch-failed", detail: String(err) };
    }
    try {
      const wtPath = await claude.createWorktree(repoObj, `claws-wt/${id}`, "sessions");
      created.push({ repo: repoObj.fullName, worktreePath: wtPath });
    } catch (err) {
      log.warn(`[sessions] Failed to create worktree for ${repoObj.fullName}: ${err}`);
      await removeWorktreesByRepo(created);
      return { ok: false, reason: "worktree-failed", detail: String(err) };
    }
  }

  const cwd = created[0].worktreePath;
  const extraWorktrees = created.slice(1);
  const addDirArgs = extraWorktrees.flatMap((w) => ["--add-dir", w.worktreePath]);

  const tmuxName = `claws-${id}`;
  let envArgs: string[];
  let shellArgs: string[];
  try {
    envArgs = capabilityEnvArgs(id, effectiveCaps, "claude", "claude");
    shellArgs = agentShellArgs(id, "claude", effectiveCaps, addDirArgs, false, effectiveModel);
  } catch (err) {
    log.warn(`[sessions] Failed to prepare session runtime for ${id}: ${err}`);
    await cleanupFailedSessionCreate(id, created);
    return { ok: false, reason: "tmux-failed", detail: String(err) };
  }
  const createRes = await tmuxCmd([
    "new-session", "-d", "-s", tmuxName,
    "-x", "120", "-y", "40",
    "-c", cwd,
    // Multi-worktree sessions stay on claude for now: codex's `resume` picker
    // has no `--continue` equivalent that reliably reattaches a multi-`--add-dir`
    // workspace, so provider choice is not offered here (#2664).
    ...envArgs, "claude", ...shellArgs,
  ]);
  if (createRes.code !== 0) {
    log.warn(`[sessions] tmux new-session failed for multi-repo session: ${createRes.stderr.trim()}`);
    await cleanupFailedSessionCreate(id, created);
    return { ok: false, reason: "tmux-failed", detail: createRes.stderr.trim() };
  }

  await applySessionTmuxOptions(tmuxName);

  let proc: pty.IPty;
  try {
    proc = spawnBridge(tmuxName, cwd);
  } catch (err) {
    log.warn(`[sessions] Failed to attach bridge to tmux session ${tmuxName}: ${err}`);
    await tmuxKillSession(tmuxName);
    await cleanupFailedSessionCreate(id, created);
    return { ok: false, reason: "bridge-failed", detail: String(err) };
  }

  try {
    await insertSession({
      id,
      tmux_name: tmuxName,
      mode: "multi-worktree-claude",
      repo: created[0].repo,
      cwd,
      worktree_path: created[0].worktreePath,
      extra_worktrees: JSON.stringify(extraWorktrees),
      capabilities: JSON.stringify(effectiveCaps),
      created_at: Date.now(),
      summary: null,
      summary_updated_at: null,
      provider: "claude",
      model: effectiveModel,
    });
  } catch (err) {
    log.error(`[sessions] Failed to persist multi-repo session ${id}: ${err}`);
    proc.kill();
    await tmuxKillSession(tmuxName);
    await cleanupFailedSessionCreate(id, created);
    return { ok: false, reason: "persist-failed", detail: String(err) };
  }

  const session: Session = {
    id,
    pty: proc,
    tmuxName,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    repo: created[0].repo,
    cwd,
    mode: "multi-worktree-claude",
    provider: "claude",
    model: effectiveModel,
    worktreePath: created[0].worktreePath,
    extraWorktrees,
    capabilities: effectiveCaps,
    scrollback: "",
    alive: true,
    exitCode: null,
    wsConnected: false,
    bridgeSpawnedAt: Date.now(),
    respawnCount: 0,
    resumable: false,
    resumeRepos: [],
    summary: null,
    summaryUpdatedAt: null,
    summaryManual: false,
  };

  wireBridgeHandlers(session);

  sessions.set(id, session);
  log.info(`[sessions] Created multi-repo session ${id} (repos: ${created.map((c) => c.repo).join(", ")}, tmux: ${tmuxName})`);
  return { ok: true, session };
}

async function reapOrphanTmuxSessions(
  knownNames: Set<string>,
  liveClawsSocket: Set<string>,
): Promise<void> {
  for (const name of liveClawsSocket) {
    if (!name.startsWith(SESSION_NAME_PREFIX)) continue;
    if (knownNames.has(name)) continue;
    log.warn(`[sessions] Reaping stray tmux session ${name} (claws socket, no DB row)`);
    await tmuxKillSession(name);
  }
  let defaultSocket: Set<string>;
  try {
    defaultSocket = await tmuxListSessionsOnDefaultSocket();
  } catch (err) {
    log.warn(`[sessions] Failed to query default tmux socket for stray sessions: ${err}`);
    return;
  }
  for (const name of defaultSocket) {
    if (!name.startsWith(SESSION_NAME_PREFIX)) continue;
    log.warn(`[sessions] Reaping stray tmux session ${name} (default socket — claws never creates here)`);
    await tmuxCmd(["kill-session", "-t", `=${name}`], null);
  }
}

function sessionIdFromTmuxName(name: string): string | null {
  return name.startsWith(SESSION_NAME_PREFIX) ? name.slice(SESSION_NAME_PREFIX.length) : null;
}

export async function recoverSessions(): Promise<void> {
  // A crash between writing a session env file and the tmux spawn that sources
  // (and deletes) it leaves a credential sitting on disk with nothing left to
  // consume it. Nothing survives a restart, so clear the lot up front.
  pruneSessionEnvFiles();

  let persisted: Awaited<ReturnType<typeof getAllPersistedSessions>>;
  try {
    persisted = await getAllPersistedSessions();
  } catch (err) {
    log.warn(`[sessions] Failed to read persisted sessions: ${err}`);
    return;
  }

  let tmuxAlive: Set<string>;
  try {
    tmuxAlive = await tmuxListSessions();
  } catch (err) {
    log.warn(`[sessions] Failed to query tmux (is tmux installed?): ${err} — skipping recovery`);
    return;
  }

  const knownNames = new Set(persisted.map((r) => r.tmux_name));
  await reapOrphanTmuxSessions(knownNames, tmuxAlive);
  try {
    tmuxAlive = await tmuxListSessions();
  } catch (err) {
    log.warn(`[sessions] Failed to re-query tmux after orphan reaping: ${err} — skipping recovery`);
    return;
  }
  for (const row of persisted) {
    if (!tmuxAlive.has(row.tmux_name)) {
      log.info(`[sessions] Persisted session ${row.id} no longer in tmux — cleaning up`);
      await teardownNonResumableSession(row.id, row.tmux_name, persistedSessionWorktrees(row));
      continue;
    }

    await applySessionTmuxOptions(row.tmux_name);

    const captured = await tmuxCapturePane(row.tmux_name);
    let proc: pty.IPty;
    try {
      proc = spawnBridge(row.tmux_name, row.cwd);
    } catch (err) {
      log.warn(`[sessions] Failed to re-attach bridge for session ${row.id}: ${err}`);
      await teardownNonResumableSession(row.id, row.tmux_name, persistedSessionWorktrees(row));
      continue;
    }

    const session: Session = {
      id: row.id,
      pty: proc,
      tmuxName: row.tmux_name,
      createdAt: row.created_at,
      lastActivity: Date.now(),
      repo: row.repo,
      cwd: row.cwd,
      mode: row.mode as SessionMode,
      provider: providerFromRow(row.provider),
      model: row.model ?? null,
      worktreePath: row.worktree_path,
      extraWorktrees: parseExtraWorktrees(row.extra_worktrees),
      capabilities: parseCapabilities(row.capabilities),
      scrollback: captured.slice(-SCROLLBACK_LIMIT),
      alive: true,
      exitCode: null,
      wsConnected: false,
      bridgeSpawnedAt: Date.now(),
      respawnCount: 0,
      resumable: false,
      resumeRepos: [],
      summary: row.summary,
      summaryUpdatedAt: row.summary_updated_at,
      summaryManual: row.summary_manual === 1,
    };

    wireBridgeHandlers(session);
    sessions.set(row.id, session);
    log.info(`[sessions] Recovered session ${row.id} (mode: ${row.mode}, tmux: ${row.tmux_name})`);
  }

  let survivingRows: Awaited<ReturnType<typeof getAllPersistedSessions>>;
  try {
    survivingRows = await getAllPersistedSessions();
  } catch (err) {
    log.warn(`[sessions] Failed to re-read persisted sessions after recovery: ${err}`);
    return;
  }

  try {
    tmuxAlive = await tmuxListSessions();
  } catch (err) {
    log.warn(`[sessions] Failed to re-query tmux after recovery: ${err}`);
    return;
  }

  await reapOrphanTmuxSessions(new Set(survivingRows.map((row) => row.tmux_name)), tmuxAlive);
  try {
    tmuxAlive = await tmuxListSessions();
  } catch (err) {
    log.warn(`[sessions] Failed to re-query tmux after final orphan reaping: ${err}`);
    return;
  }
  try {
    const keepSessionIds = new Set([
      ...survivingRows.map((row) => row.id),
      ...(await getEndedSessions()).map((row) => row.id),
      ...[...tmuxAlive]
        .map((name) => sessionIdFromTmuxName(name))
        .filter((liveId): liveId is string => liveId !== null),
    ]);
    pruneOrphanSessionPrivateState(keepSessionIds);
  } catch (err) {
    log.warn(`[sessions] Failed to prune orphaned session private-state dirs: ${err}`);
  }
}

function parseExtraWorktrees(raw: string | null): Array<{ repo: string; worktreePath: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseCapabilities(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseResumeRepos(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function persistedSessionWorktrees(
  row: Pick<PersistedSession, "repo" | "worktree_path" | "extra_worktrees">,
): Array<{ repo: string; worktreePath: string }> {
  const worktrees = parseExtraWorktrees(row.extra_worktrees);
  if (row.worktree_path && row.repo) worktrees.unshift({ repo: row.repo, worktreePath: row.worktree_path });
  return worktrees;
}

function drainSessionWorktrees(
  session: Pick<Session, "repo" | "worktreePath" | "extraWorktrees">,
): Array<{ repo: string; worktreePath: string }> {
  const worktrees = [...session.extraWorktrees];
  session.extraWorktrees = [];
  if (session.worktreePath && session.repo) {
    worktrees.unshift({ repo: session.repo, worktreePath: session.worktreePath });
    session.worktreePath = null;
  }
  return worktrees;
}

async function teardownNonResumableSession(
  sessionId: string,
  tmuxName: string,
  worktrees: Array<{ repo: string; worktreePath: string }>,
): Promise<void> {
  try {
    await deletePersistedSession(sessionId);
  } catch (err) {
    log.warn(`[sessions] Failed to delete persisted session ${sessionId}: ${err}`);
  }
  try {
    await tmuxKillSession(tmuxName);
  } catch (err) {
    log.warn(`[sessions] Failed to kill tmux session ${tmuxName}: ${err}`);
  }
  try {
    removeSessionUploadDir(sessionId);
  } catch (err) {
    log.warn(`[sessions] Failed to remove upload dir for session ${sessionId}: ${err}`);
  }
  try {
    removeSessionMcpDir(sessionId);
  } catch (err) {
    log.warn(`[sessions] Failed to remove MCP dir for session ${sessionId}: ${err}`);
  }
  await removeWorktreesByRepo(worktrees);
}

async function rollbackResumedSessionAttempt(
  sessionId: string,
  tmuxName: string,
  worktrees: Array<{ repo: string; worktreePath: string }>,
): Promise<void> {
  removeSessionEnvFile(sessionId);
  await tmuxKillSession(tmuxName).catch(() => {});
  await removeWorktreesByRepo(worktrees);
}

/**
 * Persist an ended session to history so it can be listed and resumed later.
 * Reads `extraWorktrees`/`repo` synchronously to capture the repos needed to
 * rebuild the worktree(s) on resume — MUST run before `cleanupSessionWorktree`,
 * which nulls those fields.
 */
async function recordSessionEnded(session: Session): Promise<void> {
  let resumeRepos: string[] = [];
  if (session.mode === "worktree-claude" && session.repo) resumeRepos = [session.repo];
  else if (session.mode === "multi-worktree-claude") resumeRepos = [session.repo, ...session.extraWorktrees.map((w) => w.repo)].filter(Boolean) as string[];
  try {
    await markSessionEnded(session.id, Date.now(), JSON.stringify(resumeRepos));
    for (const prunedId of await pruneEndedSessions(MAX_ENDED_SESSIONS)) {
      removeSessionUploadDir(prunedId);
      removeSessionMcpDir(prunedId);
    }
  } catch (err) {
    log.warn(`[sessions] Failed to record ended session ${session.id}: ${err}`);
  }
}

function pruneOrphanSessionPrivateState(activeSessionIds: Iterable<string>): void {
  pruneOrphanSessionMcpDirs(activeSessionIds);
  pruneOrphanSessionUploadDirs(activeSessionIds);
}

/**
 * Rebuild an in-memory Session from a DB row for an ended session, so
 * `resumeSession` can relaunch it. The `pty` field is a placeholder — the
 * reconstructed object is kept local (never published to the `sessions` map)
 * until resume assigns a live bridge, so the placeholder is never reachable
 * via `getSession()` and must never be dereferenced first.
 */
function reconstructEndedSession(row: PersistedSession): Session {
  return {
    id: row.id, pty: undefined as unknown as pty.IPty, tmuxName: row.tmux_name,
    createdAt: row.created_at, lastActivity: Date.now(), repo: row.repo, cwd: row.cwd,
    mode: row.mode as SessionMode, provider: providerFromRow(row.provider),
    model: row.model ?? null,
    worktreePath: row.worktree_path, extraWorktrees: [],
    capabilities: parseCapabilities(row.capabilities), scrollback: "", alive: false,
    exitCode: null, wsConnected: false, bridgeSpawnedAt: Date.now(), respawnCount: 0,
    resumable: true, resumeRepos: parseResumeRepos(row.resume_repos),
    summary: row.summary, summaryUpdatedAt: row.summary_updated_at,
    summaryManual: row.summary_manual === 1,
  };
}

async function removeWorktreesByRepo(
  items: Array<{ repo: string; worktreePath: string }>,
): Promise<void> {
  if (items.length === 0) return;
  const repos = await listRepos().catch(() => [] as Repo[]);
  for (const it of items) {
    const repoObj = repos.find((r) => r.fullName === it.repo);
    if (repoObj) await claude.removeWorktree(repoObj, it.worktreePath).catch(() => {});
  }
}

async function cleanupFailedSessionCreate(
  sessionId: string,
  worktrees: Array<{ repo: string; worktreePath: string }>,
): Promise<void> {
  removeSessionEnvFile(sessionId);
  await teardownNonResumableSession(sessionId, `claws-${sessionId}`, worktrees);
}

async function cleanupSessionWorktree(session: Session): Promise<void> {
  if (session.extraWorktrees.length > 0) {
    await removeWorktreesByRepo(session.extraWorktrees);
    session.extraWorktrees = [];
  }
  if (!session.worktreePath || !session.repo) return;
  const worktreePath = session.worktreePath;
  session.worktreePath = null;
  try {
    const repoObj = (await listRepos().catch(() => [] as Repo[]))
      .find((r) => r.fullName === session.repo);
    if (!repoObj) {
      log.warn(`[sessions] Cannot clean up worktree for ${session.id}: repo ${session.repo} not found`);
      return;
    }
    await claude.removeWorktree(repoObj, worktreePath);
    log.info(`[sessions] Cleaned up worktree for session ${session.id}`);
  } catch (err) {
    log.warn(`[sessions] Failed to clean up worktree for session ${session.id}: ${err}`);
  }
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function listSessions(): Array<{
  id: string;
  repo: string | null;
  extraRepos: string[];
  cwd: string;
  mode: SessionMode;
  provider: SessionProvider;
  model: string | null;
  createdAt: number;
  alive: boolean;
  resumable: boolean;
  wsConnected: boolean;
  summary: string | null;
  summaryUpdatedAt: number | null;
  endedAt: number | null;
}> {
  return [...sessions.values()].map((s) => {
    const extraRepos = s.extraWorktrees.length > 0
      ? s.extraWorktrees.map((w) => w.repo)
      : s.resumeRepos.filter((r) => r && r !== s.repo);
    return {
      id: s.id,
      repo: s.repo,
      extraRepos,
      cwd: s.cwd,
      mode: s.mode,
      provider: s.provider,
      model: s.model,
      createdAt: s.createdAt,
      alive: s.alive,
      resumable: s.resumable,
      wsConnected: s.wsConnected,
      summary: s.summary,
      summaryUpdatedAt: s.summaryUpdatedAt,
      endedAt: null,
    };
  });
}

export async function listEndedSessions(): Promise<Array<{ id: string; repo: string | null; extraRepos: string[]; cwd: string; mode: SessionMode; provider: SessionProvider; model: string | null; createdAt: number; alive: boolean; resumable: boolean; wsConnected: boolean; summary: string | null; summaryUpdatedAt: number | null; endedAt: number | null }>> {
  return (await getEndedSessions()).map((row) => ({
    id: row.id, repo: row.repo,
    extraRepos: parseResumeRepos(row.resume_repos).filter((r) => r && r !== row.repo),
    cwd: row.cwd, mode: row.mode as SessionMode, provider: providerFromRow(row.provider), model: row.model ?? null, createdAt: row.created_at,
    alive: false, resumable: true, wsConnected: false,
    summary: row.summary, summaryUpdatedAt: row.summary_updated_at, endedAt: row.ended_at,
  }));
}

/**
 * History lookup for one ended session. Returns undefined when the id has no
 * persisted row, or has a row that is still live (`ended_at IS NULL`) — only an
 * ended row is resumable via `resumeSession()`.
 */
export async function getEndedSession(id: string): Promise<{
  id: string; repo: string | null; extraRepos: string[]; cwd: string;
  provider: SessionProvider; createdAt: number; endedAt: number; summary: string | null;
} | undefined> {
  const row = await getPersistedSession(id);
  if (!row || row.ended_at == null) return undefined;
  return {
    id: row.id, repo: row.repo,
    extraRepos: parseResumeRepos(row.resume_repos).filter((r) => r && r !== row.repo),
    cwd: row.cwd, provider: providerFromRow(row.provider), createdAt: row.created_at,
    endedAt: row.ended_at, summary: row.summary,
  };
}

export function killSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  // A session that's already !alive here was abandoned by handleBridgeExit's
  // respawn-give-up branch, which already deleted its persisted row — the map
  // entry only lingers for the reaper (below) to sweep. Only a live kill (the
  // "End" button, which is only rendered for alive sessions) should move the
  // session to history; recording history a second time would silently no-op
  // against an already-deleted row while still logging "moved to history".
  const wasAlive = session.alive;
  if (wasAlive) session.pty.kill();
  if (wasAlive) {
    void tmuxKillSession(session.tmuxName);
    recordSessionEnded(session);        // reads extraWorktrees synchronously → must run BEFORE cleanup
  }
  if (wasAlive) {
    void cleanupSessionWorktree(session);
  } else {
    void teardownNonResumableSession(id, session.tmuxName, drainSessionWorktrees(session));
  }
  sessions.delete(id);
  if (wasAlive) {
    log.info(`[sessions] Ended session ${id} (moved to history)`);
  } else {
    log.info(`[sessions] Reaped abandoned session ${id} (bridge failed to respawn; not recorded in history)`);
  }
  return true;
}

/** Permanently remove a session from both memory and history. */
export async function deleteSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (session) {
    if (session.alive) session.pty.kill();
    void tmuxKillSession(session.tmuxName);
    void cleanupSessionWorktree(session);
    sessions.delete(id);
  }
  await deletePersistedSession(id);
  removeSessionUploadDir(id);
  removeSessionMcpDir(id);
  log.info(`[sessions] Deleted session ${id}`);
  return true;
}

export async function resumeSession(id: string): Promise<CreateSessionResult> {
  if (isShuttingDown()) return { ok: false, reason: "shutting-down" };
  let session = sessions.get(id);
  // A session reconstructed from history is NOT published into the live
  // `sessions` map until its bridge is live (at the end of this function).
  // Publishing early would expose a session whose `pty` is a placeholder to
  // `getSession()`/the WS route during the seconds-long worktree/tmux/bridge
  // rebuild, crashing any concurrent WS connect on `undefined.onData/resize`;
  // it would also leak an orphaned entry if the rebuild fails partway.
  const reconstructed = !session;
  if (!session) {
    const row = await getPersistedSession(id);
    if (!row) return { ok: false, reason: "repo-not-found", detail: id };
    if (row.ended_at == null) return { ok: false, reason: "not-resumable", detail: id };
    session = reconstructEndedSession(row);
  }
  if (!session.resumable && !session.alive) {
    return { ok: false, reason: "not-resumable", detail: id };
  }
  if (session.alive) return { ok: true, session }; // already running

  let stagedCwd = session.cwd;
  let stagedWorktreePath = session.worktreePath;
  let stagedExtraWorktrees = [...session.extraWorktrees];
  let rebuiltWorktrees: Array<{ repo: string; worktreePath: string }> = [];

  // Recreate worktree(s) at the SAME path so the agent's resume finds the
  // path-keyed conversation history. The worktree is rebuilt fresh from the
  // default branch — uncommitted work from the old session is gone (acceptable;
  // important work is pushed as a branch). History lives in ~/.claude or
  // ~/.codex/sessions — both cwd-keyed, and neither inside the worktree, so it
  // survives as long as the path is rebuilt identically.
  if (session.mode === "worktree-claude" || session.mode === "multi-worktree-claude") {
    const allRepos = await listRepos().catch(() => [] as Repo[]);
    for (const repoName of session.resumeRepos) {
      const repoObj = allRepos.find((r) => r.fullName === repoName);
      if (!repoObj) {
        await rollbackResumedSessionAttempt(id, session.tmuxName, rebuiltWorktrees);
        return { ok: false, reason: "repo-not-listed", detail: repoName };
      }
      try {
        const wt = await claude.createWorktree(repoObj, `claws-wt/${id}`, "sessions");
        rebuiltWorktrees.push({ repo: repoName, worktreePath: wt });
      } catch (err) {
        await rollbackResumedSessionAttempt(id, session.tmuxName, rebuiltWorktrees);
        return { ok: false, reason: "worktree-failed", detail: String(err) };
      }
    }
    if (rebuiltWorktrees.length === 0) return { ok: false, reason: "worktree-failed", detail: "no repos to rebuild" };
    stagedCwd = rebuiltWorktrees[0].worktreePath;       // identical to original cwd
    stagedWorktreePath = rebuiltWorktrees[0].worktreePath;
    stagedExtraWorktrees = rebuiltWorktrees.slice(1);
  } else if (!fs.existsSync(session.cwd)) {
    log.warn(`[sessions] Cannot resume ${id}: cwd no longer exists: ${session.cwd}`);
    return { ok: false, reason: "repo-not-found", detail: session.cwd };
  }

  const provider = session.provider ?? "claude";
  const command = session.mode === "repo-zsh" ? "zsh" : provider;
  const addDirArgs = stagedExtraWorktrees.flatMap((w) => ["--add-dir", w.worktreePath]);
  // Back-fills sessions created before #2871; does not mutate session.capabilities
  // or the persisted row, only affects this spawn.
  const caps = withImplicitCapabilities(session.capabilities, [session.repo, ...session.resumeRepos]);
  let envArgs: string[];
  let shellArgs: string[];
  try {
    envArgs = capabilityEnvArgs(id, caps, provider, command);
    shellArgs = session.mode === "repo-zsh"
      ? []
      // `codex --continue` does not exist; the equivalent is the `resume --last`
      // subcommand, which agentShellArgs emits as leading args.
      : provider === "codex"
        ? agentShellArgs(id, "codex", caps, addDirArgs, true, session.model)
        // opencode has no --add-dir, so `extra` is always [] here (multi-worktree
        // sessions are always claude, so addDirArgs is empty in practice anyway).
        : provider === "opencode"
          ? agentShellArgs(id, "opencode", caps, [], true, session.model)
          : agentShellArgs(id, "claude", caps, ["--continue", ...addDirArgs], false, session.model);
  } catch (err) {
    log.warn(`[sessions] Failed to prepare session runtime on resume of ${id}: ${err}`);
    await rollbackResumedSessionAttempt(id, session.tmuxName, rebuiltWorktrees);
    return { ok: false, reason: "tmux-failed", detail: String(err) };
  }

  const createRes = await tmuxCmd([
    "new-session", "-d", "-s", session.tmuxName,
    "-x", "120", "-y", "40", "-c", stagedCwd,
    ...envArgs, command, ...shellArgs,
  ]);
  if (createRes.code !== 0) {
    log.warn(`[sessions] tmux new-session failed on resume: ${createRes.stderr.trim()}`);
    await rollbackResumedSessionAttempt(id, session.tmuxName, rebuiltWorktrees);
    return { ok: false, reason: "tmux-failed", detail: createRes.stderr.trim() };
  }
  await applySessionTmuxOptions(session.tmuxName);

  let proc: pty.IPty;
  try {
    proc = spawnBridge(session.tmuxName, stagedCwd);
  } catch (err) {
    await rollbackResumedSessionAttempt(id, session.tmuxName, rebuiltWorktrees);
    return { ok: false, reason: "bridge-failed", detail: String(err) };
  }

  session.cwd = stagedCwd;
  session.worktreePath = stagedWorktreePath;
  session.extraWorktrees = stagedExtraWorktrees;
  session.pty = proc;
  session.alive = true;
  session.resumable = false;
  session.exitCode = null;
  session.scrollback = "";
  session.respawnCount = 0;
  session.bridgeSpawnedAt = Date.now();
  session.lastActivity = Date.now();
  if (reconstructed) sessions.set(id, session); // publish only now that pty is live
  wireBridgeHandlers(session);
  await clearSessionEnded(id);
  log.info(`[sessions] Resumed session ${id} (cwd: ${session.cwd}, mode: ${session.mode}, provider: ${provider})`);
  return { ok: true, session };
}

const SUMMARY_INTERVAL_MS = 30_000;
const inFlightSummaries = new Set<string>();

const IDLE_SUMMARY_RE = /^\s*(?:idle|waiting|sitting)\b/i;
const IDLE_AGENT_RE = /claude|codex|opencode|agent/i;

function isIdlePlaceholder(summary: string | null): boolean {
  return summary != null && IDLE_SUMMARY_RE.test(summary);
}

// Matches "#123", "PR #123", "issue #123", "owner/repo#123", "owner/repo #123",
// "pull request #123". Both the keyword and the owner/repo prefix tolerate a space
// before the "#" — otherwise "owner/repo #123" leaves the repo name behind as two
// tokens and passes for content.
const ISSUE_REF_RE = /(?:\b(?:issues?|prs?|pull\s+requests?|tickets?)\b\s*)?(?:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\s*)?#\d+/gi;

// Words that carry no information about WHAT is being worked on. If a summary
// mentions an issue/PR number and everything else it says is on this list, the
// number is doing all the work and the summary is useless to a reader.
const SUMMARY_FILLER_WORDS = new Set([
  "a", "an", "and", "at", "for", "from", "in", "into", "of", "on", "onto", "the", "to", "with", "via",
  "this", "that", "its", "some",
  "work", "works", "working", "worked",
  "review", "reviews", "reviewing", "reviewed",
  "merge", "merges", "merging", "merged",
  "fix", "fixes", "fixing", "fixed",
  "check", "checks", "checking", "checked",
  "look", "looks", "looking",
  "plan", "plans", "planning",
  "issue", "issues", "pr", "prs", "pull", "request", "requests", "ticket", "tickets",
  "comment", "comments", "feedback",
  "task", "tasks", "item", "items", "thread", "threads",
  "repo", "repos", "repository", "branch", "change", "changes", "code", "stuff", "things",
  "add", "adds", "adding", "added",
  "address", "addresses", "addressing", "addressed",
  "do", "does", "doing", "done",
  "handle", "handles", "handling", "handled",
  "implement", "implements", "implementing", "implemented",
  "resolve", "resolves", "resolving", "resolved",
  "update", "updates", "updating", "updated",
  "about", "after", "again", "before", "currently", "here", "it", "just", "now",
  "latest", "more", "new", "next", "other", "another", "several", "still", "then", "there",
  "progress", "session", "sessions", "terminal", "output",
]);

/** Remove issue/PR references and tidy the punctuation they leave behind. */
export function stripIssueRefs(summary: string): string {
  return summary
    .replace(ISSUE_REF_RE, " ")
    .replace(/\s+([,;:.])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:.\-–—]+|[\s,;:.\-–—]+$/g, "")
    .trim();
}

/** How many words in a stripped summary actually say something about the subject. */
function contentWordCount(stripped: string): number {
  const words = stripped.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
  return words.filter((w) => !SUMMARY_FILLER_WORDS.has(w)).length;
}

/** True when a summary names an issue/PR number and says nothing substantive besides. */
export function isNumberOnlySummary(summary: string): boolean {
  if (!/#\d/.test(summary)) return false;
  return contentWordCount(stripIssueRefs(summary)) < 2;
}

export const SUMMARY_RETRY_INSTRUCTION =
  "Your previous answer was REJECTED because it identified the work only by an issue or PR number, which tells a reader nothing. Answer again without mentioning any number at all: name the actual feature, component, bug or symptom visible in the terminal output above.";

/** First line, unquoted, length-capped, with idle output collapsed to a canonical string. Returns "" when unusable. */
function normalizeSummary(raw: string): string {
  let s = (raw.trim().split("\n")[0] ?? "").replace(/^["']|["']$/g, "").trim().slice(0, MAX_SESSION_DESCRIPTION_LEN);
  if (!s) return "";
  if (IDLE_SUMMARY_RE.test(s)) return IDLE_AGENT_RE.test(s) ? "Idle at Claude prompt" : "Idle at shell prompt";
  return s;
}

export async function summarizeSession(session: Session, opts: { force?: boolean } = {}): Promise<void> {
  if (isShuttingDown()) return;
  if (!session.alive) return;
  if (session.summaryManual) return;
  if (!opts.force) {
    // A number-only summary is treated like an idle placeholder: refreshable once
    // there is newer activity. Bounded — this function never persists a summary
    // that fails isNumberOnlySummary(), so at most one refresh per session.
    const refreshable = session.summary !== null &&
      (isIdlePlaceholder(session.summary) || isNumberOnlySummary(session.summary));
    if (session.summary && !refreshable) return;
    if (refreshable && session.lastActivity <= (session.summaryUpdatedAt ?? 0)) return;
  }
  if (inFlightSummaries.has(session.id)) return;
  if (!session.scrollback) return;

  const clean = stripVTControlCharacters(session.scrollback);
  const trimmed = clean.slice(-12000);
  if (trimmed.trim().length < 80) return;

  inFlightSummaries.add(session.id);
  try {
    const prompt = `Summarise what the user is currently doing in this interactive terminal session in <=8 words. Describe the actual feature, bug, or subject being worked on — name the behaviour, component, or symptom. NEVER write an issue or PR number unless the rest of the summary already names the actual subject on its own — a reader cannot look numbers up, so "Reviewing PR #1234 comments" is worthless while "Reviewing session-description edit PR" is good. When in doubt, leave the number out entirely. Do NOT include the repository, worktree, or directory name — that is already shown in a separate column, so it wastes space. Avoid generic phrases like "working on code" or "running commands". If the session is sitting at a plain shell prompt with no recent activity, reply exactly "Idle at shell prompt". If it is sitting at an idle Claude/agent prompt awaiting input, reply exactly "Idle at Claude prompt". Otherwise, if the most recent activity is a Claude/agent session, summarise the agent's current task, not the literal CLI invocation.

Reply with just the summary text. No quotes, no trailing punctuation, no preamble.

Good examples:
- Editing session summariser prompt
- Fixing WebSocket reconnect loop
- Running vitest suite on db layer
- Debugging k3s monitor alert noise
- Idle at shell prompt
- Idle at Claude prompt

Bad examples — identify the work by number alone:
- Working on #1234
- Reviewing PR #1234 comments
- Reviewing fleet-infra issue #1267 plan
- Merging PR #1566

Recent terminal output:
---
${trimmed}
---`;

    const raw = await claude.runClaude(prompt, os.homedir(), {
      provider: "claude",
      tier: "sonnet",
      timeoutMs: 60_000,
      agent: "plan",
    });

    if (session.summaryManual) return;

    let summary = normalizeSummary(raw);
    if (!summary) return;

    if (isNumberOnlySummary(summary)) {
      const retryRaw = await claude.runClaude(
        `${prompt}\n\n${SUMMARY_RETRY_INSTRUCTION}\nRejected answer: ${summary}`,
        os.homedir(),
        { provider: "claude", tier: "sonnet", timeoutMs: 60_000, agent: "plan" },
      );
      if (session.summaryManual) return; // pin may have landed during the retry
      const retry = normalizeSummary(retryRaw);
      if (retry && !isNumberOnlySummary(retry)) {
        summary = retry;
      } else {
        // Both attempts leaned on the number: strip it rather than persist it, and
        // never leave the field empty. Every candidate here is either a strip
        // product (no "#\d" left) or a hardcoded placeholder with no digits, so
        // anything this function persists passes isNumberOnlySummary() — that is
        // what bounds the refresh-gate above to a single extra call per session.
        // Keep whichever stripped candidate says the most rather than blindly
        // preferring the retry, which may be the weaker of two bad answers.
        const candidates = [stripIssueRefs(summary), retry ? stripIssueRefs(retry) : ""].filter((c) => c.length > 0);
        candidates.sort((a, b) => contentWordCount(b) - contentWordCount(a) || b.length - a.length);
        const stripped = (candidates[0] ?? "").slice(0, MAX_SESSION_DESCRIPTION_LEN);
        summary = stripped || "Unspecified session activity";
      }
    }

    session.summary = summary;
    session.summaryUpdatedAt = Date.now();
    await updateSessionSummary(session.id, summary, session.summaryUpdatedAt);
  } catch (err) {
    log.warn(`[sessions] Failed to summarize session ${session.id}: ${err}`);
  } finally {
    inFlightSummaries.delete(session.id);
  }
}

export const MAX_SESSION_DESCRIPTION_LEN = 120;

/**
 * Set or clear a user-authored description. An empty/whitespace value clears the
 * manual pin so auto-summarisation resumes. Works for live sessions (memory + DB)
 * and for ended rows (DB only).
 */
export async function setSessionDescription(id: string, description: string): Promise<{ ok: boolean; description: string | null }> {
  const value = description.replace(/\s+/g, " ").trim().slice(0, MAX_SESSION_DESCRIPTION_LEN);
  const next = value.length > 0 ? value : null;
  const updatedAt = next === null ? null : Date.now();
  let rowUpdated = false;
  try {
    rowUpdated = await setManualSessionSummary(id, next, updatedAt);
  } catch (err) {
    log.warn(`[sessions] Failed to persist description for session ${id}: ${err}`);
    return { ok: false, description: null };
  }
  const session = sessions.get(id);
  if (session) {
    session.summary = next;
    session.summaryUpdatedAt = updatedAt;
    session.summaryManual = next !== null;
  }
  return { ok: rowUpdated || session !== undefined, description: next };
}

/**
 * Clear any manual pin and force a fresh model summary for a live session.
 * `description` is null when the session lacks enough scrollback or a summary
 * was already in flight — the 30s poll will retry, so this is self-healing.
 */
export async function resummarizeSession(id: string): Promise<{ ok: boolean; description: string | null }> {
  const session = sessions.get(id);
  if (!session || !session.alive) return { ok: false, description: null };
  try { await setManualSessionSummary(id, null, null); }
  catch (err) { log.warn(`[sessions] Failed to clear pin for session ${id}: ${err}`); }
  session.summary = null;
  session.summaryUpdatedAt = null;
  session.summaryManual = false;
  await summarizeSession(session, { force: true });
  return { ok: true, description: session.summary };
}

setInterval(() => {
  if (isShuttingDown()) return;
  for (const session of sessions.values()) {
    if (!session.alive) continue;
    void summarizeSession(session);
  }
}, SUMMARY_INTERVAL_MS).unref();

// Periodically reap sessions whose tmux has died (bridge gave up respawning).
setInterval(() => {
  for (const [id, session] of sessions) {
    if (!session.alive && !session.resumable) {
      killSession(id);
    }
  }
}, 60_000).unref();

export async function disconnectAllSessions(): Promise<void> {
  const count = sessions.size;
  for (const session of sessions.values()) {
    if (session.alive) session.pty.kill();
  }
  sessions.clear();
  if (count > 0) log.info(`[sessions] Disconnected ${count} bridge(s) on shutdown (tmux sessions persist)`);
}
