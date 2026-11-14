import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STEP_CA } from "./config.js";
import * as log from "./log.js";
import { execCapture, redactSshError } from "./ssh.js";

// Short-lived SSH certificates from the in-house step-ca (#clw_01M4TVENKC78XCG6CX2VDCEEEE,
// fleet-infra docs/ssh-ca.md). Every session grant and every background SSH job
// run gets its own fresh ed25519 key, signed by the `claws` JWK provisioner for
// only the `access-<host>` principals it needs. Nothing is shared between
// sessions or jobs, and no key outlives its temp dir on the service side.

/** Validity of a background job's certificate (Decision 8). */
export const JOB_SSH_CERT_TTL_SECONDS = 10 * 60;

/** The CA could not issue a certificate: unconfigured, unreachable or refused. Logged with `log.warn`, never `[claws-error]`. */
export class SshCaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshCaError";
  }
}

export interface IssueSshCertificateRequest {
  /** Certificate key id, recorded in step-ca's and sshd's logs (e.g. `claws-session-<id>-nas`). */
  keyId: string;
  /** `access-<host>` principals the certificate is valid for. */
  principals: string[];
  /** Validity from now; the `claws` provisioner caps it at 1h. */
  ttlSeconds: number;
}

export interface SshCertificate {
  /** OpenSSH private key (unencrypted), for a 0600 file only. */
  privateKey: string;
  /** `ssh-ed25519-cert-v01@openssh.com …` line for the matching `-cert.pub` file. */
  certificate: string;
}

/** `name` lowercased, trailing `.local` stripped, every character outside `[a-z0-9-]` replaced with `-`. */
export function sshHostSlug(name: string): string {
  return name.toLowerCase().replace(/\.local\.?$/, "").replace(/[^a-z0-9-]/g, "-");
}

/** The principal Claws holds on `host`: `access-<slug>` (fleet-infra docs/ssh-ca.md#principals). */
export function accessPrincipal(host: string): string {
  return `access-${sshHostSlug(host)}`;
}

const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PRINCIPAL = /^[a-z0-9][a-z0-9-]{0,62}$/;

function caSettings(): { url: string; root: string; passwordFile: string } {
  const { url, root, provisionerPasswordFile } = STEP_CA;
  if (!url || !root || !provisionerPasswordFile) {
    throw new SshCaError("the SSH CA is not configured (CLAWS_STEP_CA_URL, CLAWS_STEP_CA_ROOT and CLAWS_STEP_PROVISIONER_PASSWORD_FILE are all required)");
  }
  return { url, root, passwordFile: provisionerPasswordFile };
}

/** A 0700 temp dir for key material, deleted by the caller. */
function makePrivateTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

export interface SignSshPublicKeyRequest extends IssueSshCertificateRequest {
  /** One-line OpenSSH public key (`ssh-ed25519 AAAA… [comment]`) to sign. */
  publicKey: string;
}

function validateRequest(req: IssueSshCertificateRequest): void {
  if (!SAFE_KEY_ID.test(req.keyId)) throw new SshCaError(`unsafe SSH certificate key id ${JSON.stringify(req.keyId)}`);
  if (req.principals.length === 0) throw new SshCaError("an SSH certificate needs at least one principal");
  for (const p of req.principals) {
    if (!SAFE_PRINCIPAL.test(p)) throw new SshCaError(`unsafe SSH principal ${JSON.stringify(p)}`);
  }
}

/**
 * Have step-ca sign the public key at `pubPath` (inside `dir`) for the
 * request's principals; returns the certificate line. Logs the outcome and
 * throws `SshCaError` with the CA URL and `dir` redacted.
 */
async function signInDir(req: IssueSshCertificateRequest, dir: string, pubPath: string, startedAt: number, keygen?: () => Promise<void>): Promise<string> {
  const ttl = Math.max(60, Math.floor(req.ttlSeconds));
  const ca = caSettings();
  try {
    if (keygen) await keygen();
    await execCapture("step", [
      "ssh", "certificate", req.keyId, pubPath,
      "--sign", "--force", "--no-agent",
      "--provisioner", "claws",
      "--provisioner-password-file", ca.passwordFile,
      "--ca-url", ca.url,
      "--root", ca.root,
      ...req.principals.flatMap((p) => ["--principal", p]),
      "--not-after", `${ttl}s`,
    ], {
      timeout: 30_000,
      // STEPPATH in the temp dir: the step CLI never reads or writes the service's ~/.step.
      env: { ...process.env, STEPPATH: path.join(dir, "step") },
    });
    const certificate = fs.readFileSync(pubPath.replace(/\.pub$/, "-cert.pub"), "utf8");
    log.info("[ssh-ca] Issued SSH certificate", { key_id: req.keyId, principals: req.principals.join(","), ttl_s: ttl, target: ca.url, duration_ms: Date.now() - startedAt });
    return certificate;
  } catch (err) {
    const redacted = redactSshError(redactSshError(err, { host: dir }, "<tmp>"), { host: ca.url }, "step-ca");
    log.warn("[ssh-ca] Could not issue SSH certificate", { key_id: req.keyId, principals: req.principals.join(","), target: "step-ca", duration_ms: Date.now() - startedAt, error: redacted.message });
    throw new SshCaError(`SSH certificate issuance failed: ${redacted.message}`);
  }
}

/**
 * Have step-ca sign a caller-held public key for `principals`, valid for
 * `ttlSeconds`, and return the certificate line. Used for session pods, which
 * generate and keep their own private keys (#clw_01M78063FGCMSJVSGS7ZDV1Z9C).
 * The key is written to a 0700 temp dir deleted before returning. Throws
 * `SshCaError` (with the CA URL and temp paths redacted) when the CA is
 * unconfigured or refuses; the caller validates the key's type.
 */
export async function signSshPublicKey(req: SignSshPublicKeyRequest): Promise<string> {
  validateRequest(req);
  caSettings();
  const dir = makePrivateTempDir("claws-ssh-ca-");
  const pubPath = path.join(dir, "id_ed25519.pub");
  try {
    fs.writeFileSync(pubPath, `${req.publicKey.trim()}\n`, { mode: 0o600 });
    return await signInDir(req, dir, pubPath, Date.now());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Generate a fresh ed25519 keypair and have step-ca sign it for `principals`,
 * valid for `ttlSeconds`. The key is generated with `ssh-keygen` and signed with
 * the `step` CLI in a 0700 temp dir that is deleted before returning, so the
 * caller holds the only copy. Throws `SshCaError` (with the CA URL and temp
 * paths redacted) when the CA is unconfigured or refuses.
 */
export async function issueSshCertificate(req: IssueSshCertificateRequest): Promise<SshCertificate> {
  validateRequest(req);
  caSettings();
  const dir = makePrivateTempDir("claws-ssh-ca-");
  const keyPath = path.join(dir, "id_ed25519");
  try {
    const certificate = await signInDir(req, dir, `${keyPath}.pub`, Date.now(), async () => {
      await execCapture("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", req.keyId, "-f", keyPath], { timeout: 15_000 });
    });
    const privateKey = fs.readFileSync(keyPath, "utf8");
    return { privateKey, certificate };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface JobSshIdentity {
  /** 0600 private key, for `ssh -i`. */
  identityFile: string;
  /** Its CA-signed certificate, for `CertificateFile`. */
  certificateFile: string;
}

/**
 * Run `fn` with a fresh per-run SSH identity for background job `job`: a new
 * key and a 10-minute certificate valid only for the `access-<host>`
 * principals of `hosts` (Decision 8). The files live in a 0700 temp dir that
 * is deleted after `fn` settles, whatever it returns or throws. Issuance
 * failures throw `SshCaError` before `fn` runs.
 */
export async function withJobSshIdentity<T>(job: string, hosts: string[], fn: (identity: JobSshIdentity) => Promise<T>): Promise<T> {
  const principals = [...new Set(hosts.map(accessPrincipal))];
  const keyId = `claws-job-${sshHostSlug(job)}-${crypto.randomBytes(4).toString("hex")}`;
  const cert = await issueSshCertificate({ keyId, principals, ttlSeconds: JOB_SSH_CERT_TTL_SECONDS });
  const dir = makePrivateTempDir("claws-job-ssh-");
  try {
    const identityFile = path.join(dir, "id_ed25519");
    const certificateFile = `${identityFile}-cert.pub`;
    fs.writeFileSync(identityFile, cert.privateKey, { mode: 0o600 });
    fs.writeFileSync(certificateFile, cert.certificate, { mode: 0o600 });
    return await fn({ identityFile, certificateFile });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
