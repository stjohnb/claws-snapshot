import { execFile } from "node:child_process";
import { resolveIdentityFile } from "./util.js";

export interface SshConnection {
  host?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

export interface BuildSshArgsOptions {
  scp?: boolean;
  strictHostKeyChecking?: "accept-new" | "yes";
}

/** Assemble the shared ssh/scp connection-option flags. Does NOT append the
 * target or command — callers do that (ssh: `user@host` then command;
 * scp: localPath then `target:remotePath`). */
export function buildSshArgs(cfg: SshConnection, opts: BuildSshArgsOptions = {}): string[] {
  const strict = opts.strictHostKeyChecking ?? "accept-new";
  const args = [
    "-o", `StrictHostKeyChecking=${strict}`,
    "-o", "ConnectTimeout=10",
    "-o", "BatchMode=yes",
  ];
  if (cfg.port && cfg.port !== 22) {
    args.push(opts.scp ? "-P" : "-p", String(cfg.port));
  }
  if (cfg.identityFile) {
    args.push("-i", resolveIdentityFile(cfg.identityFile));
  }
  return args;
}

/** A config-supplied absolute path that is safe to interpolate into an SSH
 * command string. Requires a leading `/` and restricts to a conservative
 * character set (alphanumerics, dot, underscore, slash, hyphen), which
 * excludes shell metacharacters (spaces, `;`, `$`, backticks, `|`, `&`, etc.)
 * that could break out of the interpolated command. */
const SAFE_ABSOLUTE_PATH = /^\/[a-zA-Z0-9._/-]+$/;

export function isSafeAbsolutePath(path: string): boolean {
  return SAFE_ABSOLUTE_PATH.test(path);
}

export interface ExecCaptureOptions {
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

/** Run execFile and resolve stdout as a string; reject with trimmed stderr
 * (falling back to the error message) on failure. */
export function execCapture(cmd: string, args: string[], opts: ExecCaptureOptions = {}): Promise<string> {
  const { timeout, maxBuffer = 4 * 1024 * 1024, env } = opts;
  const execOpts: { timeout?: number; maxBuffer: number; env?: NodeJS.ProcessEnv } = { maxBuffer };
  if (timeout !== undefined) execOpts.timeout = timeout;
  if (env !== undefined) execOpts.env = env;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, execOpts, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || (err as Error).message));
      else resolve(stdout.toString());
    });
  });
}
