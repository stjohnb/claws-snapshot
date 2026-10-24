import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createK8sClient, type K8sRequest, type K8sResponse } from "../k8s/api.js";

const mockReportError = vi.hoisted(() => vi.fn());
vi.mock("../error-reporter.js", () => ({ reportError: mockReportError }));

vi.mock("../config.js", () => ({ WORK_DIR: "/unused" }));

import { syncAuthSecret } from "./auth-secret-sync.js";

let tmpRoot: string;
let saDir: string;
let codexAuthPath: string;
let envFilePath: string;
let originalEnv: NodeJS.ProcessEnv;
let requests: K8sRequest[];
let respond: (req: K8sRequest) => Promise<K8sResponse>;

const SECRET_PATH = "/api/v1/namespaces/default/secrets/claws-auth";

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function client() {
  return createK8sClient({
    saDir,
    transport: (req) => {
      requests.push(req);
      return respond(req);
    },
  });
}

function sync(overrides: { saDir?: string } = {}) {
  return syncAuthSecret({ codexAuthPath, envFilePath, saDir: overrides.saDir ?? saDir, client: client() });
}

/** GET returns a Secret with `data`; PATCH succeeds. */
function mockGetSecret(data: Record<string, string>) {
  respond = async (req) =>
    req.method === "PATCH"
      ? { status: 200, body: "{}" }
      : { status: 200, body: JSON.stringify({ data }) };
}

function patchCalls(): K8sRequest[] {
  return requests.filter((r) => r.method === "PATCH");
}

function patchedData(): Record<string, string> | undefined {
  const patch = patchCalls()[0];
  return patch ? (JSON.parse(patch.body!) as { data: Record<string, string> }).data : undefined;
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
  requests = [];
  mockGetSecret({});
  mockReportError.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = originalEnv;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("syncAuthSecret", () => {
  it("does nothing when CLAWS_AUTH_SECRET_NAME is unset", async () => {
    delete process.env["CLAWS_AUTH_SECRET_NAME"];
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "abc" }));
    await sync();
    expect(requests).toHaveLength(0);
  });

  it("does nothing when the ServiceAccount token is absent", async () => {
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "abc" }));
    await sync({ saDir: path.join(tmpRoot, "no-such-dir") });
    expect(requests).toHaveLength(0);
  });

  it("does nothing when CLAWS_AUTH_SECRET_NAME is invalid", async () => {
    process.env["CLAWS_AUTH_SECRET_NAME"] = "Invalid_Name";
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "abc" }));
    await sync();
    expect(requests).toHaveLength(0);
  });

  it("does nothing when CLAWS_AUTH_SECRET_NAMESPACE is invalid", async () => {
    process.env["CLAWS_AUTH_SECRET_NAMESPACE"] = "Bad_NS";
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "abc" }));
    await sync();
    expect(requests).toHaveLength(0);
  });

  it("reads the Secret but does not patch when the codex file already matches", async () => {
    const content = JSON.stringify({ refresh_token: "abc" });
    fs.writeFileSync(codexAuthPath, content);
    mockGetSecret({ CLAWS_CODEX_AUTH_JSON: b64(content) });

    await sync();

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
  });

  it("patches the Secret when the codex file differs", async () => {
    const newContent = JSON.stringify({ refresh_token: "new-token" });
    fs.writeFileSync(codexAuthPath, newContent);
    mockGetSecret({ CLAWS_CODEX_AUTH_JSON: b64(JSON.stringify({ refresh_token: "old-token" })) });

    await sync();

    expect(requests).toHaveLength(2);
    expect(Buffer.from(patchedData()!["CLAWS_CODEX_AUTH_JSON"], "base64").toString("utf8")).toBe(newContent);
  });

  it("skips a truncated codex auth.json without patching that key", async () => {
    fs.writeFileSync(codexAuthPath, '{"OPENAI_API');

    // No Claude token in env either, so with the codex key invalid there's nothing to sync.
    await sync();

    expect(requests).toHaveLength(0);
  });

  it("includes a differing CLAUDE_CODE_OAUTH_TOKEN and excludes a matching one", async () => {
    fs.writeFileSync(envFilePath, 'CLAUDE_CODE_OAUTH_TOKEN="new-claude-token"\n');
    mockGetSecret({ CLAUDE_CODE_OAUTH_TOKEN: b64("old-claude-token") });

    await sync();

    expect(Buffer.from(patchedData()!["CLAUDE_CODE_OAUTH_TOKEN"], "base64").toString("utf8")).toBe("new-claude-token");

    // Now matching — no patch call at all.
    requests = [];
    mockGetSecret({ CLAUDE_CODE_OAUTH_TOKEN: b64("new-claude-token") });
    await sync();
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
  });

  it("patches only the changed keys, codex entry before Claude entry", async () => {
    const codex = JSON.stringify({ refresh_token: "new" });
    fs.writeFileSync(codexAuthPath, codex);
    fs.writeFileSync(envFilePath, "CLAUDE_CODE_OAUTH_TOKEN=claude-new\n");
    mockGetSecret({ OTHER: b64("x") });

    await sync();

    expect(Object.keys(patchedData()!)).toEqual(["CLAWS_CODEX_AUTH_JSON", "CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(patchedData()!["CLAUDE_CODE_OAUTH_TOKEN"]).toBe(b64("claude-new"));
  });

  it("reports and resolves when the patch call fails", async () => {
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "new-token" }));
    respond = async (req) =>
      req.method === "PATCH" ? { status: 403, body: "forbidden" } : { status: 200, body: JSON.stringify({ data: {} }) };

    await expect(sync()).resolves.toBeUndefined();
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError.mock.calls[0][1]).toBe("Failed to patch the claws-auth Secret");
  });

  it("reports and resolves when the get call fails, without attempting a patch", async () => {
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "new-token" }));
    respond = async () => {
      throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
    };

    await expect(sync()).resolves.toBeUndefined();
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError.mock.calls[0][1]).toBe("Failed to read the claws-auth Secret");
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
  });

  it("reads the Secret at its namespaced core/v1 path", async () => {
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "new-token" }));

    await sync();

    expect(requests[0]).toMatchObject({ method: "GET", path: SECRET_PATH });
  });

  it("patches with a JSON merge patch carrying only data", async () => {
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "new-token" }));

    await sync();

    const patch = patchCalls()[0];
    expect(patch.path).toBe(SECRET_PATH);
    expect(patch.headers["Content-Type"]).toBe("application/merge-patch+json");
    expect(Object.keys(JSON.parse(patch.body!))).toEqual(["data"]);
  });

  it("sends the SA token only in the Authorization header", async () => {
    fs.writeFileSync(codexAuthPath, JSON.stringify({ refresh_token: "new-token" }));

    await sync();

    expect(requests).toHaveLength(2);
    for (const req of requests) {
      expect(req.headers["Authorization"]).toBe("Bearer fake-token");
      expect(req.path).not.toContain("fake-token");
      expect(req.body ?? "").not.toContain("fake-token");
    }
  });
});
