import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshSshCertificate, SSH_REFRESH_MARGIN_MS, type SshRefreshOptions, type SshRefreshTarget } from "./ssh-refresh.js";
import { LAUNCH_SPEC_KEY } from "../k8s/workload.js";

const NOW = 1_800_000_000_000;

function sshString(v: Buffer | string): Buffer {
  const b = typeof v === "string" ? Buffer.from(v, "latin1") : v;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
}

/** A parseable ed25519 user certificate valid until `validBeforeMs`. */
function certLine(validBeforeMs: number): string {
  const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const type = "ssh-ed25519-cert-v01@openssh.com";
  const blob = Buffer.concat([
    sshString(type), sshString(Buffer.alloc(32, 1)), sshString(Buffer.alloc(32, 2)),
    u64(1n), u32(1), sshString("claws-session-abc123-nas"), sshString(sshString("access-nas")),
    u64(BigInt(Math.floor(NOW / 1000) - 60)), u64(BigInt(Math.floor(validBeforeMs / 1000))),
    sshString(""), sshString(""),
  ]);
  return `${type} ${blob.toString("base64")} claws\n`;
}

describe("refreshSshCertificate (#clw_01M78063FGCMSJVSGS7ZDV1Z9C)", () => {
  let root: string;
  let secretDir: string;
  let sshRuntime: string;
  let target: SshRefreshTarget;
  let fetchMock: ReturnType<typeof vi.fn>;
  let keygen: ReturnType<typeof vi.fn>;
  const keyPath = () => path.join(sshRuntime, "nas");
  const certPath = () => `${keyPath()}-cert.pub`;

  function run(over: Partial<SshRefreshOptions> = {}) {
    return refreshSshCertificate({
      alias: "nas",
      secretDir,
      sshRuntime,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
      sleep: async () => {},
      keygen: keygen as unknown as SshRefreshOptions["keygen"],
      loadTarget: async () => target,
      ...over,
    });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claws-ssh-refresh-"));
    secretDir = path.join(root, "secret");
    sshRuntime = path.join(root, "ssh");
    fs.mkdirSync(secretDir);
    fs.mkdirSync(sshRuntime, { mode: 0o700 });
    fs.writeFileSync(path.join(secretDir, "mcp-token"), "tok-123\n");
    target = { sessionId: "abc123", granted: true, signUrl: "http://claws:3000/api/sessions/abc123/ssh" };
    keygen = vi.fn((p: string, comment: string) => {
      fs.writeFileSync(p, "PRIVATE", { mode: 0o644 });
      fs.writeFileSync(`${p}.pub`, `ssh-ed25519 AAAAnew ${comment}\n`);
    });
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ certificate: certLine(NOW + 15 * 60_000).trim() }), { status: 200 }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does nothing when the certificate is fresh, without even reading the launch spec", async () => {
    fs.writeFileSync(keyPath(), "PRIVATE");
    fs.writeFileSync(certPath(), certLine(NOW + SSH_REFRESH_MARGIN_MS + 1_000));
    const loadTarget = vi.fn(async () => target);
    expect(await run({ loadTarget })).toEqual({ kind: "fresh" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loadTarget).not.toHaveBeenCalled();
  });

  it("makes a key on first use and signs it with the session token", async () => {
    expect(await run()).toEqual({ kind: "signed" });
    expect(keygen).toHaveBeenCalledWith(keyPath(), "claws-session-abc123-nas");
    expect(fs.statSync(keyPath()).mode & 0o777).toBe(0o600);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("http://claws:3000/api/sessions/abc123/ssh/nas/sign");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
    expect(JSON.parse(init.body as string)).toEqual({ publicKey: "ssh-ed25519 AAAAnew claws-session-abc123-nas" });
    expect(fs.readFileSync(certPath(), "utf8")).toBe(certLine(NOW + 15 * 60_000));
    expect(fs.statSync(certPath()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${keyPath()}.lock`)).toBe(false);
  });

  it("re-signs the existing key when the certificate is near expiry", async () => {
    fs.writeFileSync(keyPath(), "PRIVATE");
    fs.writeFileSync(`${keyPath()}.pub`, "ssh-ed25519 AAAAold\n");
    fs.writeFileSync(certPath(), certLine(NOW + SSH_REFRESH_MARGIN_MS - 1_000));
    expect(await run()).toEqual({ kind: "signed" });
    expect(keygen).not.toHaveBeenCalled();
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ publicKey: "ssh-ed25519 AAAAold" });
  });

  it("re-signs an unparseable certificate", async () => {
    fs.writeFileSync(keyPath(), "PRIVATE");
    fs.writeFileSync(`${keyPath()}.pub`, "ssh-ed25519 AAAAold\n");
    fs.writeFileSync(certPath(), "garbage");
    expect(await run()).toEqual({ kind: "signed" });
  });

  it("leaves the old certificate and reports a failure when signing fails", async () => {
    fs.writeFileSync(keyPath(), "PRIVATE");
    fs.writeFileSync(`${keyPath()}.pub`, "ssh-ed25519 AAAAold\n");
    const old = certLine(NOW + 30_000);
    fs.writeFileSync(certPath(), old);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "This session does not hold ssh:nas" }), { status: 403 }));
    expect(await run()).toEqual({ kind: "failed", reason: "signing refused (HTTP 403): This session does not hold ssh:nas" });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await run()).toMatchObject({ kind: "failed", reason: expect.stringContaining("Claws unreachable") });
    expect(fs.readFileSync(certPath(), "utf8")).toBe(old);
    expect(fs.existsSync(`${keyPath()}.lock`)).toBe(false);
  });

  it("does nothing for an ungranted alias or a pod with no signing URL", async () => {
    target = { ...target, granted: false };
    expect(await run()).toMatchObject({ kind: "skipped" });
    target = { sessionId: "abc123", granted: true, signUrl: undefined };
    expect(await run()).toMatchObject({ kind: "skipped" });
    expect(await run({ loadTarget: async () => null })).toMatchObject({ kind: "skipped" });
    expect(keygen).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for another ssh holding a fresh lock instead of signing twice", async () => {
    fs.writeFileSync(`${keyPath()}.lock`, "999");
    let polls = 0;
    const sleep = vi.fn(async () => {
      if (++polls === 2) {
        fs.writeFileSync(keyPath(), "PRIVATE");
        fs.writeFileSync(certPath(), certLine(NOW + 15 * 60_000));
      }
    });
    expect(await run({ sleep, now: () => fs.statSync(`${keyPath()}.lock`).mtimeMs + 1_000 })).toEqual({ kind: "fresh" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(`${keyPath()}.lock`)).toBe(true);
  });

  it("gives up waiting on a held lock without signing", async () => {
    fs.writeFileSync(`${keyPath()}.lock`, "999");
    const lockAt = fs.statSync(`${keyPath()}.lock`).mtimeMs;
    let t = lockAt + 1_000;
    expect(await run({ now: () => t, sleep: async (ms) => { t += ms; } })).toMatchObject({ kind: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces a stale lock and signs", async () => {
    fs.writeFileSync(`${keyPath()}.lock`, "999");
    const lockAt = fs.statSync(`${keyPath()}.lock`).mtimeMs;
    expect(await run({ now: () => lockAt + 60_000 })).toEqual({ kind: "signed" });
    expect(fs.existsSync(`${keyPath()}.lock`)).toBe(false);
  });

  it("reports an unreadable launch spec as one short failure", async () => {
    expect(await run({ loadTarget: async () => { throw new Error("zod\n[ long ]"); } })).toEqual({ kind: "failed", reason: "could not read the session's launch spec" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsafe alias", async () => {
    expect(await run({ alias: "../x" })).toMatchObject({ kind: "failed" });
  });

  it("reads the grant slot and signing URL from the mounted launch spec by default", async () => {
    fs.writeFileSync(path.join(secretDir, LAUNCH_SPEC_KEY), JSON.stringify({
      sessionId: "abc123", cwd: ".", command: ["zsh"], uploadDir: "u",
      ssh: [{ alias: "nas", grantKey: "ssh-grant-nas", user: "brendan", hostName: "192.168.0.128" }],
      sshSignUrl: "http://claws:3000/api/sessions/abc123/ssh",
    }));
    fs.writeFileSync(path.join(secretDir, "ssh-grant-nas"), "");
    expect(await run({ loadTarget: undefined })).toMatchObject({ kind: "skipped" });
    fs.writeFileSync(path.join(secretDir, "ssh-grant-nas"), "1");
    expect(await run({ loadTarget: undefined })).toEqual({ kind: "signed" });
  });
});
