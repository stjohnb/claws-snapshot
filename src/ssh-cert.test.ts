import { describe, it, expect } from "vitest";
import { isEd25519PublicKey, sshCertificateValidBefore } from "./ssh-cert.js";

function sshString(v: Buffer | string): Buffer {
  const b = typeof v === "string" ? Buffer.from(v, "latin1") : v;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
}
function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

const CERT_TYPE = "ssh-ed25519-cert-v01@openssh.com";

function certBlob(validBefore: bigint, opts: { type?: string; pkLen?: number } = {}): Buffer {
  return Buffer.concat([
    sshString(opts.type ?? CERT_TYPE),
    sshString(Buffer.alloc(32, 1)), // nonce
    sshString(Buffer.alloc(opts.pkLen ?? 32, 2)),
    u64(7n), // serial
    u32(1), // user cert
    sshString("claws-session-abc-nas"),
    sshString(sshString("access-nas")),
    u64(1_000n),
    u64(validBefore),
    sshString(""), // critical options
    sshString(""), // extensions
  ]);
}

const certLine = (blob: Buffer, type = CERT_TYPE) => `${type} ${blob.toString("base64")} claws\n`;

describe("sshCertificateValidBefore", () => {
  it("returns valid_before in epoch ms", () => {
    expect(sshCertificateValidBefore(certLine(certBlob(1_800_000_000n)))).toBe(1_800_000_000_000);
  });

  it("caps a forever certificate", () => {
    expect(sshCertificateValidBefore(certLine(certBlob(0xffff_ffff_ffff_ffffn)))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("is null for a truncated blob", () => {
    const blob = certBlob(1_800_000_000n);
    expect(sshCertificateValidBefore(certLine(blob.subarray(0, 120)))).toBeNull();
  });

  it("is null for another certificate type", () => {
    expect(sshCertificateValidBefore(certLine(certBlob(1n, { type: "ssh-rsa-cert-v01@openssh.com" }), "ssh-rsa-cert-v01@openssh.com"))).toBeNull();
    // Line type and blob type disagree.
    expect(sshCertificateValidBefore(certLine(certBlob(1n, { type: "ssh-rsa-cert-v01@openssh.com" })))).toBeNull();
  });

  it("is null for garbage", () => {
    expect(sshCertificateValidBefore("")).toBeNull();
    expect(sshCertificateValidBefore("not a cert")).toBeNull();
    expect(sshCertificateValidBefore(`${CERT_TYPE} !!!`)).toBeNull();
    expect(sshCertificateValidBefore(certLine(certBlob(1n, { pkLen: 31 })))).toBeNull();
  });
});

describe("isEd25519PublicKey", () => {
  const pub = (blob: Buffer, type = "ssh-ed25519") => `${type} ${blob.toString("base64")} claws-session`;

  it("accepts an ed25519 public key with or without a comment", () => {
    const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 3))]);
    expect(isEd25519PublicKey(pub(blob))).toBe(true);
    expect(isEd25519PublicKey(`ssh-ed25519 ${blob.toString("base64")}\n`)).toBe(true);
  });

  it("rejects an RSA key, a mismatched blob type, a wrong key length and trailing data", () => {
    const rsa = Buffer.concat([sshString("ssh-rsa"), sshString(Buffer.from([1, 0, 1])), sshString(Buffer.alloc(256, 9))]);
    expect(isEd25519PublicKey(pub(rsa, "ssh-rsa"))).toBe(false);
    expect(isEd25519PublicKey(pub(rsa))).toBe(false);
    expect(isEd25519PublicKey(pub(Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(31, 3))])))).toBe(false);
    expect(isEd25519PublicKey(pub(Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 3)), Buffer.from([0])])))).toBe(false);
  });

  it("rejects garbage and multi-line input", () => {
    const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 3))]);
    expect(isEd25519PublicKey("")).toBe(false);
    expect(isEd25519PublicKey("ssh-ed25519")).toBe(false);
    expect(isEd25519PublicKey("ssh-ed25519 ###")).toBe(false);
    expect(isEd25519PublicKey(`${pub(blob)}\n${pub(blob)}`)).toBe(false);
  });
});
