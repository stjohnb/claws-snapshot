import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

const { mockExecFile, mockStepCa, mockLog } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockStepCa: { url: "https://step-ca.step-ca.svc.cluster.local:9000", root: "/etc/claws/step-ca/root_ca.crt", provisionerPasswordFile: "/etc/claws/step-ca/provisioner-password" },
  mockLog: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("./config.js", () => ({ get STEP_CA() { return mockStepCa; } }));
vi.mock("./log.js", () => mockLog);

import { accessPrincipal, issueSshCertificate, signSshPublicKey, SshCaError, withJobSshIdentity, JOB_SSH_CERT_TTL_SECONDS } from "./ssh-ca.js";

/** Stub ssh-keygen and step: write the files the real tools would, recording each call. */
interface ToolCall { cmd: string; args: string[]; env?: NodeJS.ProcessEnv; dirMode?: number }

function stubTools(opts: { stepError?: string } = {}): ToolCall[] {
  const calls: ToolCall[] = [];
  mockExecFile.mockImplementation((cmd: string, args: string[], execOpts: { env?: NodeJS.ProcessEnv }, cb: ExecCb) => {
    calls.push({ cmd, args, env: execOpts.env });
    if (cmd === "ssh-keygen") {
      const keyPath = args[args.indexOf("-f") + 1]!;
      calls[calls.length - 1]!.dirMode = fs.statSync(path.dirname(keyPath)).mode & 0o777;
      // Assembled at runtime so the public-snapshot secret scan does not flag this fixture.
      const pem = (edge: string) => ["-----" + edge, "OPENSSH PRIVATE KEY-----"].join(" ");
      fs.writeFileSync(keyPath, `${pem("BEGIN")}\nfake\n${pem("END")}\n`, { mode: 0o600 });
      fs.writeFileSync(`${keyPath}.pub`, "ssh-ed25519 AAAAfake\n");
      cb(null, "", "");
      return;
    }
    if (cmd === "step") {
      if (opts.stepError) {
        cb(new Error("exit 1"), "", opts.stepError);
        return;
      }
      const pub = args[3]!;
      fs.writeFileSync(pub.replace(/\.pub$/, "-cert.pub"), "ssh-ed25519-cert-v01@openssh.com AAAAcert\n");
      cb(null, "", "");
      return;
    }
    cb(new Error(`unexpected ${cmd}`), "", "");
  });
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStepCa.url = "https://step-ca.step-ca.svc.cluster.local:9000";
  mockStepCa.root = "/etc/claws/step-ca/root_ca.crt";
  mockStepCa.provisionerPasswordFile = "/etc/claws/step-ca/provisioner-password";
});

describe("accessPrincipal", () => {
  it("maps a host name or Mac runner name to its access-<slug> principal", () => {
    expect(accessPrincipal("ryzen")).toBe("access-ryzen");
    expect(accessPrincipal("Brendans-MacBook-Pro-3")).toBe("access-brendans-macbook-pro-3");
    expect(accessPrincipal("brendans-macbook-pro.local")).toBe("access-brendans-macbook-pro");
  });
});

describe("issueSshCertificate", () => {
  it("generates a fresh ed25519 key and signs it with the claws provisioner for only the given principals", async () => {
    const calls = stubTools();

    const cert = await issueSshCertificate({ keyId: "claws-session-abc-nas", principals: ["access-nas"], ttlSeconds: 900 });

    expect(cert.privateKey).toContain("OPENSSH PRIVATE KEY");
    expect(cert.certificate).toContain("ssh-ed25519-cert-v01@openssh.com");
    const keygen = calls.find((c) => c.cmd === "ssh-keygen")!;
    expect(keygen.args).toEqual(expect.arrayContaining(["-t", "ed25519", "-N", "", "-C", "claws-session-abc-nas"]));
    const step = calls.find((c) => c.cmd === "step")!;
    expect(step.args.slice(0, 4)).toEqual(["ssh", "certificate", "claws-session-abc-nas", `${keygen.args[keygen.args.indexOf("-f") + 1]}.pub`]);
    expect(step.args).toEqual(expect.arrayContaining([
      "--sign", "--no-agent",
      "--provisioner", "claws",
      "--provisioner-password-file", "/etc/claws/step-ca/provisioner-password",
      "--ca-url", "https://step-ca.step-ca.svc.cluster.local:9000",
      "--root", "/etc/claws/step-ca/root_ca.crt",
      "--principal", "access-nas",
      "--not-after", "900s",
    ]));
    expect(step.args.filter((a) => a === "--principal")).toHaveLength(1);
    // The step CLI never touches the service's ~/.step.
    expect(step.env?.STEPPATH).toContain(path.dirname(keygen.args[keygen.args.indexOf("-f") + 1]!));
  });

  it("keys live only in a 0700 temp dir that is gone once it returns", async () => {
    const calls = stubTools();
    await issueSshCertificate({ keyId: "claws-job-x", principals: ["access-ryzen"], ttlSeconds: 600 });
    const keygen = calls.find((c) => c.cmd === "ssh-keygen")!;
    expect(keygen.dirMode).toBe(0o700);
    expect(fs.existsSync(path.dirname(keygen.args[keygen.args.indexOf("-f") + 1]!))).toBe(false);
  });

  it("refuses to run unconfigured, before generating anything", async () => {
    stubTools();
    mockStepCa.url = "";
    await expect(issueSshCertificate({ keyId: "k", principals: ["access-nas"], ttlSeconds: 900 })).rejects.toBeInstanceOf(SshCaError);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("rejects an unsafe principal or key id", async () => {
    stubTools();
    await expect(issueSshCertificate({ keyId: "k", principals: ["access-nas --principal fleet-admin"], ttlSeconds: 900 })).rejects.toBeInstanceOf(SshCaError);
    await expect(issueSshCertificate({ keyId: "-k", principals: ["access-nas"], ttlSeconds: 900 })).rejects.toBeInstanceOf(SshCaError);
    await expect(issueSshCertificate({ keyId: "k", principals: [], ttlSeconds: 900 })).rejects.toBeInstanceOf(SshCaError);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("redacts the CA URL and temp paths from a refusal, logs a warning and cleans up", async () => {
    stubTools({ stepError: "error contacting https://step-ca.step-ca.svc.cluster.local:9000 for /tmp/claws-ssh-ca-XYZ: principal not allowed" });
    const err = await issueSshCertificate({ keyId: "k", principals: ["access-prod-cluster"], ttlSeconds: 900 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SshCaError);
    expect((err as Error).message).toContain("principal not allowed");
    expect((err as Error).message).not.toContain("step-ca.step-ca.svc");
    expect(mockLog.warn).toHaveBeenCalledWith("[ssh-ca] Could not issue SSH certificate", expect.objectContaining({ target: "step-ca", duration_ms: expect.any(Number), error: expect.not.stringContaining("step-ca.step-ca.svc") }));
    const keyArgs = mockExecFile.mock.calls[0]![1] as string[];
    expect(fs.existsSync(path.dirname(keyArgs[keyArgs.indexOf("-f") + 1]!))).toBe(false);
  });

  it("logs a timed line naming the CA target on success", async () => {
    stubTools();
    await issueSshCertificate({ keyId: "k", principals: ["access-nas"], ttlSeconds: 900 });
    expect(mockLog.info).toHaveBeenCalledWith("[ssh-ca] Issued SSH certificate", expect.objectContaining({ target: expect.stringMatching(/^https:\/\/step-ca\./), duration_ms: expect.any(Number) }));
  });
});

describe("signSshPublicKey (#clw_01M78063FGCMSJVSGS7ZDV1Z9C)", () => {
  it("signs the caller's public key without generating one, and cleans up", async () => {
    const calls = stubTools();
    let seenPub = "";
    const inner = mockExecFile.getMockImplementation()!;
    mockExecFile.mockImplementation((cmd: string, args: string[], execOpts: unknown, cb: ExecCb) => {
      if (cmd === "step") seenPub = fs.readFileSync(args[3]!, "utf8");
      return inner(cmd, args, execOpts, cb);
    });
    const cert = await signSshPublicKey({ keyId: "claws-session-abc-nas", principals: ["access-nas"], ttlSeconds: 900, publicKey: "ssh-ed25519 AAAApod pod\n" });
    expect(cert).toContain("ssh-ed25519-cert-v01@openssh.com");
    expect(seenPub).toBe("ssh-ed25519 AAAApod pod\n");
    expect(calls.some((c) => c.cmd === "ssh-keygen")).toBe(false);
    const step = calls.find((c) => c.cmd === "step")!;
    expect(step.args).toEqual(expect.arrayContaining(["--principal", "access-nas", "--not-after", "900s", "--provisioner", "claws"]));
    expect(fs.existsSync(path.dirname(step.args[3]!))).toBe(false);
    expect(mockLog.info).toHaveBeenCalledWith("[ssh-ca] Issued SSH certificate", expect.objectContaining({ key_id: "claws-session-abc-nas" }));
  });

  it("throws SshCaError and logs a warning when the CA refuses", async () => {
    stubTools({ stepError: "unauthorized" });
    await expect(signSshPublicKey({ keyId: "k", principals: ["access-nas"], ttlSeconds: 900, publicKey: "ssh-ed25519 AAAA" })).rejects.toBeInstanceOf(SshCaError);
    expect(mockLog.warn).toHaveBeenCalledWith("[ssh-ca] Could not issue SSH certificate", expect.objectContaining({ key_id: "k" }));
  });

  it("refuses to run unconfigured", async () => {
    stubTools();
    mockStepCa.url = "";
    await expect(signSshPublicKey({ keyId: "k", principals: ["access-nas"], ttlSeconds: 900, publicKey: "ssh-ed25519 AAAA" })).rejects.toBeInstanceOf(SshCaError);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe("withJobSshIdentity", () => {
  it("runs fn with a 10-minute certificate for only the hosts' principals, then deletes the files", async () => {
    const calls = stubTools();
    let seen: { identityFile: string; certificateFile: string } | null = null;
    let modes: number[] = [];

    const result = await withJobSshIdentity("runner-monitor", ["ryzen", "Brendans-MacBook-Pro", "ryzen"], async (id) => {
      seen = id;
      modes = [fs.statSync(path.dirname(id.identityFile)).mode & 0o777, fs.statSync(id.identityFile).mode & 0o777];
      expect(fs.readFileSync(id.certificateFile, "utf8")).toContain("cert-v01");
      return 42;
    });

    expect(result).toBe(42);
    expect(modes).toEqual([0o700, 0o600]);
    expect(fs.existsSync(seen!.identityFile)).toBe(false);
    const step = calls.find((c) => c.cmd === "step")!;
    expect(step.args.filter((_a, i) => step.args[i - 1] === "--principal")).toEqual(["access-ryzen", "access-brendans-macbook-pro"]);
    expect(step.args).toContain(`${JOB_SSH_CERT_TTL_SECONDS}s`);
    expect(step.args[2]).toMatch(/^claws-job-runner-monitor-[0-9a-f]{8}$/);
  });

  it("deletes the files when fn throws", async () => {
    stubTools();
    let keyFile = "";
    await expect(withJobSshIdentity("mac-runner-waker", ["nas"], async (id) => {
      keyFile = id.identityFile;
      throw new Error("ssh failed");
    })).rejects.toThrow("ssh failed");
    expect(fs.existsSync(keyFile)).toBe(false);
  });

  it("never calls fn when the CA refuses", async () => {
    stubTools({ stepError: "unauthorized" });
    const fn = vi.fn();
    await expect(withJobSshIdentity("runner-monitor", ["nas"], fn)).rejects.toBeInstanceOf(SshCaError);
    expect(fn).not.toHaveBeenCalled();
  });
});
