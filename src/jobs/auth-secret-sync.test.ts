import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: mockExecFile }));

const mockReportError = vi.hoisted(() => vi.fn());
vi.mock("../error-reporter.js", () => ({ reportError: mockReportError }));

vi.mock("../config.js", () => ({ WORK_DIR: "/unused" }));

import { syncAuthSecret } from "./auth-secret-sync.js";

let tmpRoot: string;
let saDir: string;
let codexAuthPath: string;
let envFilePath: string;
let originalEnv: NodeJS.ProcessEnv;

function argsOf(callIndex: number): string[] {
  return mockExecFile.mock.calls[callIndex][1] as string[];
}

function optsOf(callIndex: number): { env?: NodeJS.ProcessEnv } {
  return mockExecFile.mock.calls[callIndex][2] as { env?: NodeJS.ProcessEnv };
}

function isPatchCall(args: string[]): boolean {
  return args.includes("patch");
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function mockGetSecret(data: Record<string, string>) {
  mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
    if (isPatchCall(args)) {
      cb(null, "", "");
    } else {
      cb(null, JSON.stringify({ data }), "");
    }
  });
}

beforeEach(() => {
  originalEnv = { ...process.env };
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "auth-secret-sync-test-"));
  saDir = path.join(tmpRoot, "sa");
  fs.mkdirSync(saDir, { recursive: true });
  fs.writeFileSync(path.join(saDir, "token"), "fake-token");
  fs.writeFileSync(path.join(saDir, "ca.crt"), "fake-ca");
  codexAuthPath = path.join(tmpRoot, "auth.json");
  envFilePath = path.join(tmpRoot, "env");
  process.env["CLAWS_AUTH_SECRET_NAME"] = "claws-auth";
  process.env["CLAWS_AUTH_SECRET_NAMESPACE"] = "default";
  mockExecFile.mockReset();
  mockReportError.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = originalEnv;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("syncAuthSecret", () => {
  it("does nothing when CLAWS_AUTH_SECRET_NAME is unset", async () => {
    delete process.env["CLAWS_AUTH_SECRET_NAME"];
    await syncAuthSecret({ codexAuthPath, envFilePath, saDir });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("does nothing when the ServiceAccount token is absent", async () => {
    await syncAuthSecret({ codexAuthPath, envFilePath, saDir: path.join(tmpRoot, "no-such-dir") });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("does nothing when CLAWS_AUTH_SECRET_NAME is invalid", async () => {
    process.env["CLAWS_AUTH_SECRET_NAME"] = "Invalid_Name";
    await syncAuthSecret({ codexAuthPath, envFilePath, saDir });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("does nothing when CLAWS_AUTH_SECRET_NAMESPACE is invalid", async () => {
    process.env["CLAWS_AUTH_SECRET_NAMESPACE"] = "Bad_NS";
    await syncAuthSecret({ codexAuthPath, envFilePath, saDir });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("reads the Secret but does not patch when the codex file already matches", async () => {
    const content = JSON.stringify({ refresh_token: "abc" });
    fs.writeFileSync(codexAuthPath, content);
    mockGetSecret({ CLAWS_CODEX_AUTH_JSON: b64(content) });

    await syncAuthSecret({ codexAuthPath, envFilePath, saDir });

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(argsOf(0)).toContain("get");
  });

  it("patches the Secret when the codex file differs", async () => {
    const newContent = JSON.stringify({ refresh_token: "new-token" });
    fs.writeFileSync(codexAuthPath, newContent);
    mockGetSecret({ CLAWS_CODEX_AUTH_JSON: b64(JSON.stringify({ refresh_token: "old-token" })) });

    let patchedData: Record<string, string> | undefined;
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      if (isPatchCall(args)) {
        const patchFileIdx = args.indexOf("--patch-file");
        const patchFile = args[patchFileIdx + 1];
        patchedData = JSON.parse(fs.readFileSync(patchFile, "utf8")).data;
        expect(args).toContain("--type=merge");
        cb(null, "", "");
      } else {
        cb(null, JSON.stringify({ data: { CLAWS_CODEX_AUTH_JSON: b64(JSON.stringify({ refresh_token: "old-token" })) } }), "");
      }
    });

    await syncAuthSecret({ codexAuthPath, envFilePath, saDir });

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(patchedData).toBeDefined();
    expect(Buffer.from(patchedData!["CLAWS_CODEX_AUTH_JSON"], "base64").toString("utf8")).toBe(newContent);
  });

  it("skips a truncated codex auth.json without patching that key", async () => {
    fs.writeFileSync(codexAuthPath, '{"OPENAI_API');
    mockGetSecret({});

    let patchedData: Record<string, string> | undefined;
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      if (isPatchCall(args)) {
        const patchFileIdx = args.indexOf("--patch-file");
        const patchFile = args[patchFileIdx + 1];
        patchedData = JSON.parse(fs.readFileSync(patchFile, "utf8")).data;
        cb(null, "", "");
      } else {
        cb(null, JSON.stringify({ data: {} }), "");
      }
    });

    // No Claude token in env either, so with the codex key invalid there's nothing to sync.
    await syncAuthSecret({ codexAuthPath, envFilePath, saDir });

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(patchedData).toBeUndefined();
  });

  it("includes a differing CLAUDE_CODE_OAUTH_TOKEN and excludes a matching one", async () => {
    fs.writeFileSync(envFilePath, 'CLAUDE_CODE_OAUTH_TOKEN="new-claude-token"\n');
    mockGetSecret({ CLAUDE_CODE_OAUTH_TOKEN: b64("old-claude-token") });

    let patchedData: Record<string, string> | undefined;
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      if (isPatchCall(args)) {
        const patchFileIdx = args.indexOf("--patch-file");
        const patchFile = args[patchFileIdx + 1];
        patchedData = JSON.parse(fs.readFileSync(patchFile, "utf8")).data;
        cb(null, "", "");
      } else {
        cb(null, JSON.stringify({ data: { CLAUDE_CODE_OAUTH_TOKEN: b64("old-claude-token") } }), "");
      }
    });

    await syncAuthSecret({ codexAuthPath, envFilePath, saDir });

    expect(patchedData).toBeDefined();
    expect(Buffer.from(patchedData!["CLAUDE_CODE_OAUTH_TOKEN"], "base64").toString("utf8")).toBe("new-claude-token");

    // Now matching — no patch call at all.
    mockExecFile.mockReset();
    mockGetSecret({ CLAUDE_CODE_OAUTH_TOKEN: b64("new-claude-token") });
    await syncAuthSecret({ codexAuthPath, envFilePath, saDir });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(argsOf(0)).toContain("get");
  });

  it("reports and resolves when the patch call rejects", async () => {
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "new-token" }));
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      if (isPatchCall(args)) {
        cb(new Error("boom"), "", "patch failed");
      } else {
        cb(null, JSON.stringify({ data: {} }), "");
      }
    });

    await expect(syncAuthSecret({ codexAuthPath, envFilePath, saDir })).resolves.toBeUndefined();
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it("reports and resolves when the get call rejects, without attempting a patch", async () => {
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "new-token" }));
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      cb(new Error("boom"), "", "get failed");
    });

    await expect(syncAuthSecret({ codexAuthPath, envFilePath, saDir })).resolves.toBeUndefined();
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(argsOf(0)).toContain("get");
  });

  it("spawns kubectl with KUBECONFIG=/dev/null so ~/.kube/config cannot override the SA token", async () => {
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "new-token" }));
    process.env["KUBECONFIG"] = "/home/claws/.kube/config";
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      if (isPatchCall(args)) cb(null, "", "");
      else cb(null, JSON.stringify({ data: {} }), "");
    });

    await syncAuthSecret({ codexAuthPath, envFilePath, saDir });

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      expect(optsOf(i).env?.["KUBECONFIG"]).toBe("/dev/null");
      // the rest of the parent env is still inherited
      expect(optsOf(i).env?.["CLAWS_AUTH_SECRET_NAME"]).toBe("claws-auth");
    }
  });

  it("never puts the SA token on kubectl argv; passes --kubeconfig instead", async () => {
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "new-token" }));
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      if (isPatchCall(args)) cb(null, "", "");
      else cb(null, JSON.stringify({ data: {} }), "");
    });

    await syncAuthSecret({ codexAuthPath, envFilePath, saDir });

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      expect(argsOf(i)).not.toContain("fake-token");
      expect(argsOf(i)).toContain("--kubeconfig");
    }
  });

  it("writes a 0600 kubeconfig with the SA token, server, and CA path", async () => {
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "new-token" }));
    let kubeconfig: { clusters: { cluster: Record<string, string> }[]; users: { user: { token: string } }[] } | undefined;
    let mode: number | undefined;
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      const idx = (args as string[]).indexOf("--kubeconfig");
      const kubeconfigPath = (args as string[])[idx + 1];
      kubeconfig = JSON.parse(fs.readFileSync(kubeconfigPath, "utf8"));
      mode = fs.statSync(kubeconfigPath).mode & 0o777;
      if (isPatchCall(args)) cb(null, "", "");
      else cb(null, JSON.stringify({ data: {} }), "");
    });

    await syncAuthSecret({ codexAuthPath, envFilePath, saDir });

    expect(kubeconfig).toBeDefined();
    expect(kubeconfig!.users[0].user.token).toBe("fake-token");
    expect(kubeconfig!.clusters[0].cluster["server"]).toBe("https://kubernetes.default.svc");
    expect(kubeconfig!.clusters[0].cluster["certificate-authority"]).toMatch(/\/ca\.crt$/);
    expect(mode).toBe(0o600);
  });

  it("removes the temp dir (and kubeconfig) once syncAuthSecret resolves", async () => {
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "new-token" }));
    let capturedDir: string | undefined;
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      const idx = (args as string[]).indexOf("--kubeconfig");
      capturedDir = path.dirname((args as string[])[idx + 1]);
      if (isPatchCall(args)) cb(null, "", "");
      else cb(null, JSON.stringify({ data: {} }), "");
    });

    await syncAuthSecret({ codexAuthPath, envFilePath, saDir });

    expect(capturedDir).toBeDefined();
    expect(fs.existsSync(capturedDir!)).toBe(false);
  });

  it("removes the temp dir even when the get call fails", async () => {
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "new-token" }));
    let capturedDir: string | undefined;
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      const idx = (args as string[]).indexOf("--kubeconfig");
      capturedDir = path.dirname((args as string[])[idx + 1]);
      cb(new Error("boom"), "", "get failed");
    });

    await syncAuthSecret({ codexAuthPath, envFilePath, saDir });

    expect(capturedDir).toBeDefined();
    expect(fs.existsSync(capturedDir!)).toBe(false);
  });
});
