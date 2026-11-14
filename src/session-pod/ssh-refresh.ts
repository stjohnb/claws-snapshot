import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MCP_TOKEN_KEY, WORKLOAD_RUNTIME_DIR, WORKLOAD_SECRET_DIR } from "../k8s/workload.js";
import { sshCertificateValidBefore } from "../ssh-cert.js";

// Session pod ssh refresh helper (#clw_01M78063FGCMSJVSGS7ZDV1Z9C), entry
// `dist/session-pod/ssh-refresh.js <alias>`. The session's ssh config runs it
// from a `Match originalhost <alias>,<hostName> exec` line before every ssh to a
// granted host. It makes the pod's own ed25519 key for the host on first use and
// has Claws sign it only when the certificate is missing or near expiry, so an
// idle session signs nothing and the private key never leaves the pod.
//
// It must never get in ssh's way: it always exits 0 (so the empty `Match` block
// changes nothing), prints nothing on success and one short stderr line on
// failure, after which ssh proceeds with whatever certificate is there. The
// fresh-certificate path reads one file and imports nothing heavy; the launch
// spec (and its zod schema) is loaded only when a signing is needed. Runs with
// no Claws config, database or logger.

/** Re-sign when the certificate has less than this left. */
export const SSH_REFRESH_MARGIN_MS = 2 * 60 * 1000;
/** A lock younger than this belongs to a refresh still running; an older one is stale and replaced. */
export const SSH_REFRESH_LOCK_STALE_MS = 30_000;
/** How long a second ssh waits for the refresh holding the lock to write a fresh certificate. */
export const SSH_REFRESH_LOCK_WAIT_MS = 15_000;
const SSH_REFRESH_LOCK_POLL_MS = 250;
/** Timeout of the signing request to Claws. */
export const SSH_SIGN_TIMEOUT_MS = 10_000;

export interface SshRefreshOptions {
  alias: string;
  /** Mounted Secret dir: the launch spec, the grant slots and `mcp-token`. */
  secretDir?: string;
  /** Runtime SSH dir holding `<alias>`, `<alias>.pub`, `<alias>-cert.pub` and `<alias>.lock`. */
  sshRuntime?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Generate an unencrypted ed25519 key at `keyPath` (and `keyPath.pub`). */
  keygen?: (keyPath: string, comment: string) => void;
  /** The alias's grant slot and the signing URL; defaults to reading the mounted launch spec. */
  loadTarget?: (secretDir: string, alias: string) => Promise<SshRefreshTarget | null>;
}

export interface SshRefreshTarget {
  sessionId: string;
  /** Whether the alias's mounted grant slot is filled. */
  granted: boolean;
  /** Base signing URL from the launch spec; absent on a pod that cannot sign. */
  signUrl: string | undefined;
}

/**
 * What a run did: `fresh` (certificate already valid long enough), `signed`,
 * `skipped` (not granted, no signing URL, or another ssh refreshed it), or
 * `failed` with a one-line reason.
 */
export type SshRefreshOutcome =
  | { kind: "fresh" }
  | { kind: "signed" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

const SAFE_ALIAS = /^[a-z0-9][a-z0-9-]*$/;

function defaultKeygen(keyPath: string, comment: string): void {
  const res = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", keyPath], { stdio: ["ignore", "ignore", "pipe"], timeout: 15_000 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`ssh-keygen exited ${res.status}: ${res.stderr?.toString().trim() ?? ""}`);
}

async function defaultLoadTarget(secretDir: string, alias: string): Promise<SshRefreshTarget | null> {
  // Loaded lazily: the launch spec schema pulls in zod and the terminal server.
  const { loadLaunchSpec, sshAliasGranted } = await import("./main.js");
  const spec = loadLaunchSpec(secretDir);
  const entry = spec.ssh.find((e) => e.alias === alias);
  if (!entry) return null;
  return { sessionId: spec.sessionId, granted: sshAliasGranted(entry, secretDir), signUrl: spec.sshSignUrl };
}

function readFileOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Whether `<alias>` has a key and a certificate valid for at least the margin at `nowMs`. */
function certificateFresh(keyPath: string, nowMs: number): boolean {
  if (!fs.existsSync(keyPath)) return false;
  const cert = readFileOrNull(`${keyPath}-cert.pub`);
  if (cert === null) return false;
  const validBefore = sshCertificateValidBefore(cert);
  return validBefore !== null && validBefore - nowMs >= SSH_REFRESH_MARGIN_MS;
}

/** Take `<alias>.lock` with an exclusive create; true when this run holds it. A stale lock is replaced. */
function tryLock(lockPath: string, nowMs: number): boolean {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  let age: number;
  try {
    age = nowMs - fs.statSync(lockPath).mtimeMs;
  } catch {
    age = Infinity; // Released between the create and the stat: try again below.
  }
  if (age < SSH_REFRESH_LOCK_STALE_MS) return false;
  fs.rmSync(lockPath, { force: true });
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure `<alias>` has a key and a certificate with at least
 * `SSH_REFRESH_MARGIN_MS` left, signing a new one through Claws when not.
 * Never throws: every failure comes back as `failed`.
 */
export async function refreshSshCertificate(opts: SshRefreshOptions): Promise<SshRefreshOutcome> {
  const { alias } = opts;
  const secretDir = opts.secretDir ?? WORKLOAD_SECRET_DIR;
  const sshRuntime = opts.sshRuntime ?? path.join(WORKLOAD_RUNTIME_DIR, "ssh");
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const doFetch = opts.fetch ?? fetch;
  const keygen = opts.keygen ?? defaultKeygen;
  const loadTarget = opts.loadTarget ?? defaultLoadTarget;
  if (!SAFE_ALIAS.test(alias)) return { kind: "failed", reason: "invalid host alias" };
  const keyPath = path.join(sshRuntime, alias);
  const certPath = `${keyPath}-cert.pub`;
  const lockPath = `${keyPath}.lock`;

  try {
    if (certificateFresh(keyPath, now())) return { kind: "fresh" };

    let target: SshRefreshTarget | null;
    try {
      target = await loadTarget(secretDir, alias);
    } catch {
      return { kind: "failed", reason: "could not read the session's launch spec" };
    }
    if (!target || !target.granted) return { kind: "skipped", reason: "host not granted" };
    if (!target.signUrl) return { kind: "skipped", reason: "this session cannot sign SSH certificates" };

    if (!tryLock(lockPath, now())) {
      // Another ssh to this host is signing: wait for its certificate rather than sign twice.
      const deadline = now() + SSH_REFRESH_LOCK_WAIT_MS;
      while (now() < deadline) {
        await sleep(SSH_REFRESH_LOCK_POLL_MS);
        if (certificateFresh(keyPath, now())) return { kind: "fresh" };
        if (!fs.existsSync(lockPath)) break;
      }
      return { kind: "skipped", reason: "another ssh is refreshing this host's certificate" };
    }
    try {
      if (certificateFresh(keyPath, now())) return { kind: "fresh" };
      if (!fs.existsSync(keyPath) || !fs.existsSync(`${keyPath}.pub`)) {
        // A new key invalidates any certificate for an old one.
        for (const p of [keyPath, `${keyPath}.pub`, certPath]) fs.rmSync(p, { force: true });
        keygen(keyPath, `claws-session-${target.sessionId}-${alias}`);
        fs.chmodSync(keyPath, 0o600);
      }
      const publicKey = fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
      const token = (readFileOrNull(path.join(secretDir, MCP_TOKEN_KEY)) ?? "").trim();
      if (!token) return { kind: "failed", reason: "no session token mounted" };
      const url = `${target.signUrl.replace(/\/+$/, "")}/${alias}/sign`;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ publicKey }),
          signal: AbortSignal.timeout(SSH_SIGN_TIMEOUT_MS),
        });
      } catch (err) {
        return { kind: "failed", reason: `Claws unreachable (${err instanceof Error ? err.name : "error"})` };
      }
      let body: { certificate?: unknown; error?: unknown } = {};
      try {
        body = await res.json() as typeof body;
      } catch {
        // Non-JSON reply: reported by status below.
      }
      if (!res.ok || typeof body.certificate !== "string") {
        const detail = typeof body.error === "string" ? `: ${body.error.slice(0, 200)}` : "";
        return { kind: "failed", reason: `signing refused (HTTP ${res.status})${detail}` };
      }
      if (sshCertificateValidBefore(body.certificate) === null) return { kind: "failed", reason: "Claws returned an unreadable certificate" };
      const tmp = `${certPath}.tmp`;
      fs.writeFileSync(tmp, body.certificate.endsWith("\n") ? body.certificate : `${body.certificate}\n`, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, certPath);
      return { kind: "signed" };
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  } catch (err) {
    return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
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
  const alias = process.argv[2] ?? "";
  void refreshSshCertificate({ alias })
    .then((outcome) => {
      if (outcome.kind !== "failed") return;
      const reason = outcome.reason.replace(/\s+/g, " ").trim().slice(0, 200);
      process.stderr.write(`claws: could not refresh the SSH certificate for ${alias}: ${reason}\n`);
    })
    .catch(() => {})
    .finally(() => {
      // Always 0: a non-zero exit would only make the empty Match block not apply.
      process.exitCode = 0;
    });
}
