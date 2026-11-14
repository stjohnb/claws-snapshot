// Import-free OpenSSH key and certificate parsing (#clw_01M78063FGCMSJVSGS7ZDV1Z9C),
// shared by the service's signing route and the session pod's ssh refresh
// helper (`session-pod/ssh-refresh.ts`), which runs with no Claws config.

const ED25519_TYPE = "ssh-ed25519";
const ED25519_CERT_TYPE = "ssh-ed25519-cert-v01@openssh.com";
const ED25519_KEY_BYTES = 32;

/** Reads the uint32-length-prefixed fields of an SSH wire-format blob; every read returns null past the end. */
class SshBlobReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  string(): Buffer | null {
    const len = this.uint32();
    if (len === null || this.offset + len > this.buf.length) return null;
    const out = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  uint32(): number | null {
    if (this.offset + 4 > this.buf.length) return null;
    const v = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  uint64(): bigint | null {
    if (this.offset + 8 > this.buf.length) return null;
    const v = this.buf.readBigUInt64BE(this.offset);
    this.offset += 8;
    return v;
  }

  get done(): boolean {
    return this.offset === this.buf.length;
  }
}

/** The `<type> <base64>` fields of a one-line OpenSSH key or certificate, or null when malformed. */
function splitKeyLine(line: string): { type: string; blob: Buffer } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [type, b64] = parts as [string, string];
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const blob = Buffer.from(b64, "base64");
  return blob.length > 0 ? { type, blob } : null;
}

/**
 * When the `ssh-ed25519-cert-v01@openssh.com` certificate on `certLine` stops
 * being valid, in epoch ms, or null when the line is not a parseable ed25519
 * certificate. A certificate valid "forever" (`valid_before` all ones) is
 * reported as `Number.MAX_SAFE_INTEGER`.
 */
export function sshCertificateValidBefore(certLine: string): number | null {
  const parsed = splitKeyLine(certLine);
  if (!parsed || parsed.type !== ED25519_CERT_TYPE) return null;
  const r = new SshBlobReader(parsed.blob);
  const type = r.string();
  if (!type || type.toString("latin1") !== ED25519_CERT_TYPE) return null;
  if (r.string() === null) return null; // nonce
  const pk = r.string();
  if (!pk || pk.length !== ED25519_KEY_BYTES) return null;
  if (r.uint64() === null) return null; // serial
  if (r.uint32() === null) return null; // cert type
  if (r.string() === null) return null; // key id
  if (r.string() === null) return null; // valid principals
  if (r.uint64() === null) return null; // valid_after
  const validBefore = r.uint64();
  if (validBefore === null) return null;
  const ms = validBefore * 1000n;
  return ms > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(ms);
}

/**
 * Whether `line` is exactly an OpenSSH `ssh-ed25519` public key: the type
 * named on the line and inside the blob, and a 32-byte key with nothing after
 * it. A trailing comment is allowed.
 */
export function isEd25519PublicKey(line: string): boolean {
  if (/[\r\n]/.test(line.trim())) return false;
  const parsed = splitKeyLine(line);
  if (!parsed || parsed.type !== ED25519_TYPE) return false;
  const r = new SshBlobReader(parsed.blob);
  const type = r.string();
  if (!type || type.toString("latin1") !== ED25519_TYPE) return false;
  const key = r.string();
  return key !== null && key.length === ED25519_KEY_BYTES && r.done;
}
