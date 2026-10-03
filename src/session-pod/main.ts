import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  CLONE_ENV_KEY,
  GITHUB_TOKEN_KEY,
  LAUNCH_SPEC_KEY,
  TERMINAL_TOKEN_KEY,
  WORKLOAD_HOME,
  WORKLOAD_RUNTIME_DIR,
  WORKLOAD_SECRET_DIR,
} from "../k8s/workload.js";
import { startTerminalServer, TerminalServerStartError, type TerminalServer } from "./terminal-server.js";
import * as log from "./log.js";

// Session pod runtime (#3026), entry `dist/session-pod/main.js`:
//   prepare — init container: clone the session's repos onto the HOME PVC.
//   serve   — main container: set up HOME and runtime files, then run the
//             terminal server that owns the session's tmux session.
//
// Runs with no Claws config, database or logger, so it must never import
// `config.js`, `log.js`, `db.js` or anything that pulls them in; it logs with
// `./log.js`, a wrapper over the import-free `../log-core.js`. Importing this module has no side effects.

/** Where `serve` copies the session env file; the session argv's `/bin/sh` prelude sources and deletes it. */
export const SESSION_ENV_PATH = path.join(WORKLOAD_RUNTIME_DIR, "session.env");
/** Materialised SSH files; selected default key names in `~/.ssh` symlink here while SSH is granted. */
export const SSH_RUNTIME_DIR = path.join(WORKLOAD_RUNTIME_DIR, "ssh");
/** Directory holding the `gh` shim, prepended to PATH. */
export const GH_SHIM_DIR = path.join(WORKLOAD_RUNTIME_DIR, "bin");
/** Mounted GitHub installation token, updated in place when Claws patches the Secret. */
export const GITHUB_TOKEN_PATH = path.join(WORKLOAD_SECRET_DIR, GITHUB_TOKEN_KEY);

const SAFE_FILENAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

export const SessionLaunchSpecSchema = z.object({
  sessionId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Working directory of the tmux session, relative to HOME or absolute inside it. */
  cwd: z.string(),
  /** Initial process of the tmux session. */
  command: z.array(z.string()),
  /** Upload directory for `POST /uploads`, inside HOME. */
  uploadDir: z.string(),
  /** Repos `prepare` clones. `branch` is created only on a fresh clone. */
  repos: z.array(z.object({ url: z.string(), dir: z.string(), branch: z.string().optional() })).default([]),
  /** Files `serve` writes inside HOME before starting tmux. */
  files: z.array(z.object({
    path: z.string(),
    content: z.string(),
    mode: z.number().int().optional(),
    onlyIfAbsent: z.boolean().optional(),
  })).default([]),
  /** Secret key of the session env file, copied to `SESSION_ENV_PATH` at 0600. */
  envFileKey: z.string().regex(SAFE_FILENAME).optional(),
  /** Secret keys materialised into `~/.ssh` (via `SSH_RUNTIME_DIR`) as `name`. Empty means SSH is not granted. */
  ssh: z.array(z.object({ key: z.string().regex(SAFE_FILENAME), name: z.string().regex(SAFE_FILENAME) })).default([]),
  /** CODEX_HOME inside HOME; defaults to `~/.codex`. */
  codexHome: z.string().optional(),
  /** Secret key of the granted Codex `auth.json`, copied into CODEX_HOME only if absent. */
  codexAuthKey: z.string().regex(SAFE_FILENAME).optional(),
  /** Idle time before a large Claude session is auto-compacted (#3090). Absent or 0 means off. */
  autoCompactIdleMs: z.number().int().nonnegative().optional(),
  /** Claude Code state that skips its first-run screens (#3131); absent for other agents. */
  claudeSetup: z.object({ theme: z.string(), trustDirs: z.array(z.string()) }).optional(),
  /** Where the terminal server reports the process's exit code and final output (#3311); absent skips the report. */
  exitReportUrl: z.string().url().optional(),
});

export type SessionLaunchSpec = z.infer<typeof SessionLaunchSpecSchema>;

export interface PodPaths {
  home: string;
  runtimeDir: string;
  secretDir: string;
  skelDir: string;
  skillsScript: string;
}

export const DEFAULT_POD_PATHS: PodPaths = {
  home: WORKLOAD_HOME,
  runtimeDir: WORKLOAD_RUNTIME_DIR,
  secretDir: WORKLOAD_SECRET_DIR,
  skelDir: "/etc/skel",
  skillsScript: "/opt/claws/deploy/install-skills.sh",
};

export function loadLaunchSpec(secretDir: string = WORKLOAD_SECRET_DIR): SessionLaunchSpec {
  const raw = fs.readFileSync(path.join(secretDir, LAUNCH_SPEC_KEY), "utf8");
  return SessionLaunchSpecSchema.parse(JSON.parse(raw));
}

/** Resolve `p` against `home`, refusing anything outside it. */
export function resolveInHome(home: string, p: string): string {
  const resolved = path.resolve(home, p);
  if (resolved !== home && !resolved.startsWith(home + path.sep)) {
    throw new Error(`path escapes HOME: ${p}`);
  }
  return resolved;
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isNonEmptyDir(p: string): boolean {
  try {
    return fs.readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

function seedDirCreateOnly(src: string, dest: string): void {
  if (!exists(src)) return;
  try {
    if (!fs.lstatSync(dest).isDirectory()) return;
  } catch {
    // Destination does not exist yet.
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    const st = fs.lstatSync(srcPath);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      seedDirCreateOnly(srcPath, destPath);
      continue;
    }
    if (exists(destPath)) continue;
    fs.cpSync(srcPath, destPath, { recursive: true });
  }
}

/** Strip userinfo from every URL in `text` before it is logged. */
export function redactUrl(text: string): string {
  return text.replace(/\/\/[^/@\s]*@/g, "//");
}

// ── prepare ──

export type GitRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stderr: string }>;

const defaultGitRunner: GitRunner = (args, env) => new Promise((resolve) => {
  const proc = spawn("git", args, { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d.toString(); });
  proc.on("exit", (code) => resolve({ code: code ?? 1, stderr }));
  proc.on("error", (err) => resolve({ code: 1, stderr: String(err) }));
});

/**
 * Clone credentials are the auth-only env vars from `buildGitAuthEnv`. The
 * writer must never serialise a whole env (the Secret would then hold every
 * service secret); this filter is defence in depth, and also keeps a stray
 * PATH/HOME from replacing the pod's.
 */
const CLONE_ENV_KEY_RE = /^(GIT_[A-Z0-9_]+|GH_TOKEN|GITHUB_TOKEN|CLAWS_[A-Z_]*GIT_[A-Z_]*TOKEN)$/;

function readCloneEnv(secretDir: string): Record<string, string> {
  const file = path.join(secretDir, CLONE_ENV_KEY);
  if (!exists(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const env: Record<string, string> = {};
  if (parsed && typeof parsed === "object") {
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && CLONE_ENV_KEY_RE.test(k)) env[k] = v;
    }
  }
  return env;
}

/**
 * Remove "other" access from HOME, the session PVC's mount root. The storage
 * provisioner may create it world-writable, and kubelet's fsGroup handling only
 * adds group bits. The dir is usually root-owned and the pod runs unprivileged,
 * so it is chmodded only when this uid owns it; otherwise, or on any error, it
 * warns and carries on — a launch never fails over this. Group bits and setgid
 * are kept: without group rw + setgid on the root, kubelet's `OnRootMismatch`
 * check re-chowns the whole volume on every mount.
 */
export function secureHome(home: string, getuid: () => number = () => process.getuid?.() ?? -1): void {
  try {
    const st = fs.lstatSync(home);
    const mode = st.mode & 0o7777;
    if ((mode & 0o007) === 0) return;
    if (st.uid !== getuid()) {
      log.warn(
        `${home} is world-accessible (mode ${mode.toString(8)}, owner uid ${st.uid}) and not ours to chmod — `
        + "the storage provisioner must create it without world access",
      );
      return;
    }
    const tightened = mode & 0o7770;
    fs.chmodSync(home, tightened);
    log.info(`Removed world access from ${home} (mode ${mode.toString(8)} → ${tightened.toString(8)})`);
  } catch (err) {
    log.warn(`Could not check or tighten ${home}'s permissions: ${(err as NodeJS.ErrnoException).code ?? err} — continuing`);
  }
}

/**
 * Init container step. Clones each repo whose dir has no `.git` into a
 * temporary sibling, creates `branch` there, then renames it into place — so a
 * clone interrupted mid-way never looks like an existing checkout. A dir that
 * already has `.git` is left completely alone (no fetch, reset or checkout):
 * that is how resume keeps uncommitted work. First strips world access from
 * HOME (see `secureHome`). Returns the process exit code.
 */
export async function prepare(
  spec: SessionLaunchSpec,
  opts: { paths?: Partial<PodPaths>; runGit?: GitRunner; getuid?: () => number } = {},
): Promise<number> {
  const paths = { ...DEFAULT_POD_PATHS, ...opts.paths };
  const runGit = opts.runGit ?? defaultGitRunner;
  secureHome(paths.home, opts.getuid);

  let env: NodeJS.ProcessEnv;
  try {
    env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...readCloneEnv(paths.secretDir) };
  } catch (err) {
    log.error(`Invalid ${CLONE_ENV_KEY}: ${err instanceof Error ? err.name : "parse error"}`);
    return 1;
  }

  for (const repo of spec.repos) {
    let dir: string;
    try {
      dir = resolveInHome(paths.home, repo.dir);
    } catch (err) {
      log.error(`${err}`);
      return 1;
    }
    if (exists(path.join(dir, ".git"))) {
      log.info(`${dir} already has a checkout — leaving it untouched`);
      continue;
    }
    // Renaming the clone over a non-empty dir would fail on every start, and
    // the files there may be the user's — leave them alone instead.
    if (isNonEmptyDir(dir)) {
      log.warn(`${dir} exists without a checkout — leaving it untouched`);
      continue;
    }

    const tmp = `${dir}.claws-clone`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });

    log.info(`Cloning ${redactUrl(repo.url)} into ${dir}`);
    const clone = await runGit(["clone", "--", repo.url, tmp], env);
    if (clone.code !== 0) {
      log.error(`git clone of ${redactUrl(repo.url)} failed (exit ${clone.code}): ${redactUrl(clone.stderr.trim())}`);
      fs.rmSync(tmp, { recursive: true, force: true });
      return 1;
    }
    if (repo.branch) {
      const branch = await runGit(["-C", tmp, "checkout", "-b", repo.branch], env);
      if (branch.code !== 0) {
        log.error(`Creating branch ${repo.branch} failed (exit ${branch.code}): ${redactUrl(branch.stderr.trim())}`);
        fs.rmSync(tmp, { recursive: true, force: true });
        return 1;
      }
    }
    try {
      fs.renameSync(tmp, dir);
    } catch (err) {
      log.error(`Could not move the clone into ${dir}: ${(err as NodeJS.ErrnoException).code ?? err}`);
      fs.rmSync(tmp, { recursive: true, force: true });
      return 1;
    }
  }
  return 0;
}

// ── serve ──

type JsonObject = Record<string, unknown>;

function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read a JSON object file for a merge. A missing file is `{}`; a file that is
 * not a JSON object returns null so the caller leaves it alone rather than
 * clobbering state Claude Code wrote.
 */
function readJsonObject(p: string): JsonObject | null {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(p: string, value: JsonObject, mode: number): void {
  // Resolve a symlinked target (e.g. ~/.claude.json pointing elsewhere) so the
  // rename replaces its contents in place rather than replacing the symlink
  // itself with a regular file. A path that does not exist yet — the normal
  // case for a brand-new session — keeps `p` and is written as a new file.
  let target = p;
  try {
    target = fs.realpathSync(p);
  } catch {
    // realpathSync raises ENOENT both when `p` does not exist and when `p` is a
    // symlink whose target does not exist; resolve the link by hand so only a
    // genuinely absent path falls through and keeps `target` as `p`.
    try {
      target = path.resolve(path.dirname(p), fs.readlinkSync(p));
    } catch {
      // Not a symlink, or does not exist yet.
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.claws-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}

/**
 * Pre-answer Claude Code's first-run screens (#3131): onboarding (theme, login
 * method, security notes), folder trust for the session's checkouts, and the
 * bypass-permissions warning (pod sessions always run with
 * `--dangerously-skip-permissions`). Merged into whatever Claude Code already
 * wrote, and the theme is set only when absent, so a resume keeps the user's
 * choices. These are Claude Code's internal state keys, not a public API.
 */
export function seedClaudeState(home: string, setup: NonNullable<SessionLaunchSpec["claudeSetup"]>): void {
  const globalPath = path.join(home, ".claude.json");
  const global = readJsonObject(globalPath);
  if (global === null) {
    log.warn(`${globalPath} is not a JSON object — leaving it; Claude Code may show its first-run screens`);
  } else {
    global.hasCompletedOnboarding = true;
    const projects = isJsonObject(global.projects) ? global.projects : {};
    for (const dir of setup.trustDirs) {
      const abs = resolveInHome(home, dir);
      const existing = isJsonObject(projects[abs]) ? projects[abs] : {};
      projects[abs] = { ...existing, hasTrustDialogAccepted: true };
    }
    global.projects = projects;
    writeJsonAtomic(globalPath, global, 0o600);
  }

  const settingsPath = path.join(home, ".claude", "settings.json");
  const settings = readJsonObject(settingsPath);
  if (settings === null) {
    log.warn(`${settingsPath} is not a JSON object — leaving it`);
    return;
  }
  if (typeof settings.theme !== "string" && setup.theme) settings.theme = setup.theme;
  settings.skipDangerousModePermissionPrompt = true;
  writeJsonAtomic(settingsPath, settings, 0o644);
}

function copyFile0600(src: string, dest: string): void {
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o600);
}

function isSymlinkTo(p: string, target: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink() && path.resolve(path.dirname(p), fs.readlinkSync(p)) === path.resolve(target);
  } catch {
    return false;
  }
}

function ensureOwnedSshLink(homeSsh: string, sshRuntime: string, name: string): void {
  const link = path.join(homeSsh, name);
  const target = path.join(sshRuntime, name);
  if (!exists(target)) return;
  if (isSymlinkTo(link, target)) return;
  if (exists(link)) {
    log.warn(`${link} exists and is not Claws' symlink — leaving it; granted ${name} is in ${sshRuntime}`);
    return;
  }
  fs.symlinkSync(target, link);
}

function removeOwnedSshLink(homeSsh: string, sshRuntime: string, name: string): void {
  const link = path.join(homeSsh, name);
  if (isSymlinkTo(link, path.join(sshRuntime, name))) fs.unlinkSync(link);
}

function findRealGh(pathEnv: string, shimDir: string): string {
  for (const dir of pathEnv.split(":")) {
    if (!dir || path.resolve(dir) === path.resolve(shimDir)) continue;
    const candidate = path.join(dir, "gh");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return "/usr/bin/gh";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const OLD_TOKEN_TEST = `test -r ${GITHUB_TOKEN_PATH} || exit 0`;

export function upgradeGitCredentialHelper(gitconfigPath: string): void {
  let content: string;
  try {
    content = fs.readFileSync(gitconfigPath, "utf8");
  } catch {
    return;
  }
  if (!content.includes(OLD_TOKEN_TEST)) return;
  fs.writeFileSync(gitconfigPath, content.split(OLD_TOKEN_TEST).join(`test -s ${GITHUB_TOKEN_PATH} || exit 0`));
}

/**
 * Every filesystem step `serve` performs before tmux starts. Returns the PATH
 * the session should run with (the `gh` shim first). Throws on failures that
 * would leave the session running with the wrong credentials.
 */
export function setupHome(spec: SessionLaunchSpec, pathsIn: Partial<PodPaths> = {}): { pathEnv: string; codexHome: string } {
  const paths = { ...DEFAULT_POD_PATHS, ...pathsIn };
  const { home, runtimeDir, secretDir } = paths;
  fs.mkdirSync(home, { recursive: true });

  const sshRuntime = path.join(runtimeDir, "ssh");
  const homeSsh = path.join(home, ".ssh");
  const homeSshIsOurLink = (() => {
    try {
      return fs.lstatSync(homeSsh).isSymbolicLink() && path.resolve(home, fs.readlinkSync(homeSsh)) === path.resolve(sshRuntime);
    } catch {
      return false;
    }
  })();
  // Migrate dangling legacy links before recursive skeleton seeding.
  if (homeSshIsOurLink) fs.unlinkSync(homeSsh);

  // 1. Dotfiles from /etc/skel — the PVC hides the image's own HOME.
  seedDirCreateOnly(paths.skelDir, home);

  // 2. Launch files.
  for (const file of spec.files) {
    const dest = resolveInHome(home, file.path);
    if (file.onlyIfAbsent && exists(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const mode = file.mode ?? 0o600;
    fs.writeFileSync(dest, file.content, { mode });
    fs.chmodSync(dest, mode);
  }

  // 2b. A .gitconfig written before #3131 tests the token file with `-r`, which an
  // empty slot passes, handing git an empty password. It is never rewritten, so patch it.
  upgradeGitCredentialHelper(path.join(home, ".gitconfig"));

  // 2c. Claude Code first-run state — a convenience, so never fatal.
  if (spec.claudeSetup) {
    try {
      seedClaudeState(home, spec.claudeSetup);
    } catch (err) {
      log.warn(`Could not seed Claude Code state — it may show its first-run screens: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 3. Session env file → in-memory runtime dir at 0600 (the Secret mount is 0440).
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (spec.envFileKey) copyFile0600(path.join(secretDir, spec.envFileKey), path.join(runtimeDir, "session.env"));

  // 4. SSH. Never traverse user-owned symlinks or replace non-directory paths.
  const canMergeSsh = !exists(homeSsh) || fs.lstatSync(homeSsh).isDirectory();
  if (spec.ssh.length > 0) {
    if (canMergeSsh) {
      fs.mkdirSync(homeSsh, { recursive: true, mode: 0o700 });
      fs.chmodSync(homeSsh, 0o700);
      seedDirCreateOnly(path.join(paths.skelDir, ".ssh"), homeSsh);
    } else {
      log.warn(`${homeSsh} is a user-owned symlink or non-directory — leaving it; granted SSH keys are in ${sshRuntime}`);
    }
    fs.mkdirSync(sshRuntime, { recursive: true, mode: 0o700 });
    fs.chmodSync(sshRuntime, 0o700);
    for (const { key, name } of spec.ssh) {
      const src = path.join(secretDir, key);
      if (!exists(src)) {
        log.warn(`SSH Secret key ${key} is not mounted — skipping`);
        continue;
      }
      copyFile0600(src, path.join(sshRuntime, name));
    }
    if (canMergeSsh) {
      ensureOwnedSshLink(homeSsh, sshRuntime, "id_ed25519");
      ensureOwnedSshLink(homeSsh, sshRuntime, "id_rsa");
    }
  } else if (canMergeSsh) {
    removeOwnedSshLink(homeSsh, sshRuntime, "id_ed25519");
    removeOwnedSshLink(homeSsh, sshRuntime, "id_rsa");
  }

  // 5. Codex auth — only if absent, so a refresh-token rotation inside the session persists.
  const codexHome = resolveInHome(home, spec.codexHome ?? ".codex");
  if (spec.codexAuthKey) {
    const dest = path.join(codexHome, "auth.json");
    if (!exists(dest)) {
      fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      copyFile0600(path.join(secretDir, spec.codexAuthKey), dest);
    }
  }

  // 6. `gh` shim: exports GH_TOKEN from the mounted, in-place-refreshed token file.
  // The slot is empty until github-auth is granted (#3131), hence `-s`, not `-r`.
  const shimDir = path.join(runtimeDir, "bin");
  const basePath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const tokenPath = path.join(secretDir, GITHUB_TOKEN_KEY);
  fs.mkdirSync(shimDir, { recursive: true });
  const shim = [
    "#!/bin/sh",
    "# Claws session pod: use the GitHub App token Claws keeps fresh in the mounted Secret.",
    `if [ -s ${shellQuote(tokenPath)} ]; then`,
    `  GH_TOKEN="$(cat ${shellQuote(tokenPath)})"`,
    "  export GH_TOKEN",
    "fi",
    `exec ${shellQuote(findRealGh(basePath, shimDir))} "$@"`,
    "",
  ].join("\n");
  const shimPath = path.join(shimDir, "gh");
  fs.writeFileSync(shimPath, shim, { mode: 0o755 });
  fs.chmodSync(shimPath, 0o755);

  return { pathEnv: `${shimDir}:${basePath}`, codexHome };
}

/** Main container step: set up HOME, install skills, run the terminal server until tmux ends. */
export async function serve(spec: SessionLaunchSpec, pathsIn: Partial<PodPaths> = {}): Promise<void> {
  // Installed first so a pod deleted mid-startup still exits 0 (Succeeded)
  // instead of dying by signal; acted on once the terminal server exists.
  let server: TerminalServer | null = null;
  let shutdownRequested = false;
  process.once("SIGTERM", () => {
    shutdownRequested = true;
    if (server) void server.shutdown();
  });

  const paths = { ...DEFAULT_POD_PATHS, ...pathsIn };
  const { pathEnv, codexHome } = setupHome(spec, paths);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: paths.home, PATH: pathEnv, CODEX_HOME: codexHome };

  if (exists(paths.skillsScript)) {
    const res = spawnSync(paths.skillsScript, [paths.home, "claws"], {
      env,
      stdio: "inherit",
    });
    if (res.status !== 0) log.warn(`install-skills.sh failed (exit ${res.status ?? res.error}) — continuing`);
  }

  // spawnSync blocks the event loop, so a SIGTERM during install-skills.sh is only seen now.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (shutdownRequested) {
    log.info("SIGTERM during setup — exiting before starting tmux");
    process.exit(0);
  }

  try {
    server = await startTerminalServer({
      sessionId: spec.sessionId,
      cwd: resolveInHome(paths.home, spec.cwd),
      command: spec.command,
      uploadDir: resolveInHome(paths.home, spec.uploadDir),
      readToken: () => fs.readFileSync(path.join(paths.secretDir, TERMINAL_TOKEN_KEY), "utf8"),
      env,
      ...(spec.exitReportUrl ? { exitReportUrl: spec.exitReportUrl } : {}),
      ...(spec.autoCompactIdleMs ? { autoCompact: { idleMs: spec.autoCompactIdleMs, claudeHome: paths.home } } : {}),
    });
  } catch (err) {
    if (shutdownRequested) process.exit(0);
    throw err;
  }
  if (shutdownRequested) await server.shutdown();
}

export async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (command !== "prepare" && command !== "serve") {
    process.stderr.write("usage: session-pod/main.js prepare|serve\n");
    process.exit(2);
  }

  let spec: SessionLaunchSpec;
  try {
    spec = loadLaunchSpec();
  } catch (err) {
    // A JSON syntax error message quotes the input, so only zod's (structural) message is printed.
    log.error(`Could not load the launch spec: ${err instanceof z.ZodError ? err.message : err instanceof Error ? err.name : "unknown error"}`);
    process.exit(1);
  }
  log.setSessionId(spec.sessionId);

  if (command === "prepare") {
    process.exit(await prepare(spec));
  }

  try {
    await serve(spec);
  } catch (err) {
    const prefix = err instanceof TerminalServerStartError ? "Terminal server failed to start" : "Session setup failed";
    log.error(`${prefix}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main(process.argv.slice(2));
}
