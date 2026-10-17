import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  openaiKey: "",
  openrouterKey: "",
  execFile: vi.fn(),
}));

vi.mock("./config.js", () => ({
  get OPENAI_API_KEY() { return mocks.openaiKey; },
  get OPENROUTER_API_KEY() { return mocks.openrouterKey; },
}));
vi.mock("./log.js", () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

import { splitPiModel, piAuthJsonFromCodex, writePiAuthJson, piCredentialEnv, piCredentialSources, piCredentialStatuses } from "./pi-auth.js";

function jwt(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

let tmp: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auth-test-"));
  process.env["CODEX_HOME"] = path.join(tmp, "codex");
  delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  mocks.openaiKey = "";
  mocks.openrouterKey = "";
  mocks.execFile.mockReset();
});

afterEach(() => {
  process.env = { ...savedEnv };
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeCodexAuth(tokens: Record<string, unknown>): string {
  const dir = path.join(tmp, "codex");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "auth.json");
  fs.writeFileSync(p, JSON.stringify({ auth_mode: "chatgpt", tokens }));
  return p;
}

describe("splitPiModel", () => {
  it("splits at the first slash", () => {
    expect(splitPiModel("anthropic/claude-opus-5-5")).toEqual({ provider: "anthropic", id: "claude-opus-5-5" });
    expect(splitPiModel("openrouter/anthropic/claude-opus-4")).toEqual({ provider: "openrouter", id: "anthropic/claude-opus-4" });
    expect(splitPiModel("openai-codex/gpt-5.5")).toEqual({ provider: "openai-codex", id: "gpt-5.5" });
  });

  it("returns no provider for an unprefixed model", () => {
    expect(splitPiModel("claude-haiku-4-5")).toEqual({ provider: null, id: "claude-haiku-4-5" });
  });
});

describe("piAuthJsonFromCodex", () => {
  it("translates the Codex tokens into pi's openai-codex OAuth entry with expires from the JWT", () => {
    const access = jwt({ exp: 1_900_000_000 });
    const p = writeCodexAuth({ id_token: "i", access_token: access, refresh_token: "r", account_id: "acct" });
    expect(JSON.parse(piAuthJsonFromCodex(p)!)).toEqual({
      "openai-codex": { type: "oauth", access, refresh: "r", expires: 1_900_000_000_000, accountId: "acct" },
    });
  });

  it("falls back to one hour from now when the access token is not a JWT", () => {
    const p = writeCodexAuth({ access_token: "opaque", refresh_token: "r", account_id: "acct" });
    const before = Date.now();
    const expires = JSON.parse(piAuthJsonFromCodex(p)!)["openai-codex"].expires as number;
    expect(expires).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  it("defaults to $CODEX_HOME/auth.json", () => {
    writeCodexAuth({ access_token: "a", refresh_token: "r", account_id: "acct" });
    expect(piAuthJsonFromCodex()).not.toBeNull();
  });

  it("returns null when the file is missing or any token field is absent", () => {
    expect(piAuthJsonFromCodex(path.join(tmp, "nope.json"))).toBeNull();
    expect(piAuthJsonFromCodex(writeCodexAuth({ access_token: "a", refresh_token: "r" }))).toBeNull();
    expect(piAuthJsonFromCodex(writeCodexAuth({ access_token: "a", account_id: "x" }))).toBeNull();
    expect(piAuthJsonFromCodex(writeCodexAuth({ refresh_token: "r", account_id: "x" }))).toBeNull();
  });
});

describe("writePiAuthJson", () => {
  it("writes auth.json 0600 from the Codex login, and removes it when there is none", () => {
    const agentDir = path.join(tmp, "agent");
    fs.mkdirSync(agentDir);
    writeCodexAuth({ access_token: "a", refresh_token: "r", account_id: "acct" });
    writePiAuthJson(agentDir);
    const authPath = path.join(agentDir, "auth.json");
    expect(fs.statSync(authPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))["openai-codex"].accountId).toBe("acct");

    fs.rmSync(path.join(tmp, "codex"), { recursive: true });
    writePiAuthJson(agentDir);
    expect(fs.existsSync(authPath)).toBe(false);
  });
});

describe("piCredentialEnv and piCredentialSources", () => {
  it("carries only the quiet flags when nothing is configured", () => {
    expect(piCredentialEnv()).toEqual({ PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
    expect(piCredentialSources()).toEqual([]);
  });

  it("maps the Claude token to ANTHROPIC_OAUTH_TOKEN and passes the configured API keys", () => {
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-x";
    mocks.openaiKey = "sk-openai";
    mocks.openrouterKey = "sk-or";
    writeCodexAuth({ access_token: "a", refresh_token: "r", account_id: "acct" });
    expect(piCredentialEnv()).toEqual({
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-x",
      OPENAI_API_KEY: "sk-openai",
      OPENROUTER_API_KEY: "sk-or",
    });
    expect(piCredentialSources()).toEqual(["anthropic", "openai-codex", "openai", "openrouter"]);
  });
});

describe("piCredentialStatuses", () => {
  it("checks configured providers with --no-refresh and reports the rest not_configured", async () => {
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-x";
    mocks.openrouterKey = "sk-or";
    mocks.execFile.mockImplementation((_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }, cb: (err: unknown, stdout: string) => void) => {
      const provider = args[args.indexOf("--provider") + 1];
      expect(opts.env["ANTHROPIC_OAUTH_TOKEN"]).toBe("sk-ant-oat01-x");
      expect(opts.env["PI_CODING_AGENT_DIR"]).toBeTruthy();
      if (provider === "anthropic") cb(null, JSON.stringify({ status: "ready", provider }));
      else cb(Object.assign(new Error("exit 1"), { code: 1 }), JSON.stringify({ status: "not_ready", provider, reason: "credentials_not_configured" }));
    });

    const statuses = await piCredentialStatuses();
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
    for (const call of mocks.execFile.mock.calls) {
      expect(call[0]).toBe("pi");
      expect(call[1]).toEqual(expect.arrayContaining(["auth", "check", "--json", "--no-refresh"]));
    }
    expect(statuses.map((s) => [s.provider, s.status])).toEqual([
      ["anthropic", "ready"],
      ["openai-codex", "not_configured"],
      ["openai", "not_configured"],
      ["openrouter", "not_ready"],
    ]);
    expect(statuses[3]!.reason).toBe("credentials_not_configured");
  });

  it("reports error, not the output, when pi cannot run", async () => {
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-x";
    mocks.execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (err: unknown, stdout: string) => void) => {
      cb(Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" }), "");
    });
    const [anthropic] = await piCredentialStatuses();
    expect(anthropic).toMatchObject({ provider: "anthropic", status: "error", reason: "pi CLI not installed" });
  });
});
