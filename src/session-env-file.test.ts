import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    rmSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("./config.js", () => ({ WORK_DIR: "/home/test/.claws" }));
vi.mock("node:os", () => ({ default: { homedir: () => "/home/codex" } }));

import {
  sessionEnvDir,
  writeSessionEnvFile,
  writeSessionGrantedEnvFile,
  removeSessionGrantedEnvFile,
  sessionGrantedEnvFileWith,
  removeSessionEnvFile,
  pruneSessionEnvFiles,
  ensureSessionMcpDir,
  sessionCodexHomeDir,
  ensureSessionCodexHome,
  sessionOpencodeDir,
  ensureSessionOpencodeConfig,
  pruneOrphanSessionMcpDirs,
  removeSessionMcpDir,
  renderSessionEnvFile,
  codexConfigBody,
  codexRemoteMcpServersToml,
  opencodeConfigBody,
  CODEX_DISABLE_UPDATE_CHECK_TOML,
} from "./session-env-file.js";

describe("session-env-file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readdirSync.mockReturnValue([]);
  });

  it("writes the env file at 0600 under WORK_DIR/session-env", () => {
    const file = writeSessionEnvFile("abc123", { HOME_ASSISTANT_TOKEN: "tok" });

    expect(file).toBe("/home/test/.claws/session-env/abc123.env");
    expect(sessionEnvDir()).toBe("/home/test/.claws/session-env");
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      file,
      "export HOME_ASSISTANT_TOKEN='tok'\n",
      { mode: 0o600 },
    );
  });

  it("renderSessionEnvFile is pure and matches what writeSessionEnvFile writes (#3026)", () => {
    const vars = { A: "plain", B: "it's quoted" };
    expect(renderSessionEnvFile(vars)).toBe("export A='plain'\nexport B='it'\\''s quoted'\n");
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    writeSessionEnvFile("abc123", vars);
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(expect.any(String), renderSessionEnvFile(vars), { mode: 0o600 });
  });

  it("codexConfigBody carries developer_instructions only when non-empty", () => {
    expect(codexConfigBody("")).not.toContain("developer_instructions");
    expect(codexConfigBody("Be careful")).toContain('developer_instructions = "Be careful"');
  });

  it("codexConfigBody always disables the startup update check, before developer_instructions (#3312)", () => {
    const empty = codexConfigBody("");
    expect(empty).toContain(CODEX_DISABLE_UPDATE_CHECK_TOML);

    const withInstructions = codexConfigBody("Be careful");
    expect(withInstructions).toContain(CODEX_DISABLE_UPDATE_CHECK_TOML);
    expect(withInstructions.indexOf(CODEX_DISABLE_UPDATE_CHECK_TOML)).toBeLessThan(
      withInstructions.indexOf("developer_instructions"),
    );
  });

  it("renders Codex remote MCP TOML with quoted URL and token env var", () => {
    const toml = codexRemoteMcpServersToml(
      "claws-state",
      "http://claws:3000/mcp/sessions/a\"b",
      "CLAWS_SESSION_MCP_TOKEN",
    );

    expect(toml).toBe([
      "[mcp_servers.claws-state]",
      'url = "http://claws:3000/mcp/sessions/a\\"b"',
      'bearer_token_env_var = "CLAWS_SESSION_MCP_TOKEN"',
    ].join("\n"));
  });

  it("renders OpenCode config JSON with remote MCP headers quoted by JSON", () => {
    const body = opencodeConfigBody("/tmp/instructions.md", {
      "claws-state": {
        type: "remote",
        url: "http://claws:3000/mcp/sessions/a'b",
        headers: { Authorization: "Bearer tok\"en" },
      },
    });

    expect(JSON.parse(body)).toEqual({
      $schema: "https://opencode.ai/config.json",
      instructions: ["/tmp/instructions.md"],
      mcp: {
        "claws-state": {
          type: "remote",
          url: "http://claws:3000/mcp/sessions/a'b",
          headers: { Authorization: "Bearer tok\"en" },
        },
      },
    });
  });

  it("chmods the file to 0600 and the dir to 0700 (umask/existing-file safety)", () => {
    const file = writeSessionEnvFile("abc123", { K: "v" });

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(sessionEnvDir(), { recursive: true, mode: 0o700 });
    expect(mockFs.chmodSync).toHaveBeenCalledWith(sessionEnvDir(), 0o700);
    expect(mockFs.chmodSync).toHaveBeenCalledWith(file, 0o600);
  });

  it("writes granted.env in the session MCP dir at 0600, forcing the dir to 0700 (#3072)", () => {
    const file = writeSessionGrantedEnvFile("abc123", ["prod-infra", "fleet-infra"], { KUBECONFIG: "/k/a:/k/b" });

    expect(file).toBe("/home/test/.claws/session-mcp/abc123/granted.env");
    expect(file.startsWith(sessionEnvDir())).toBe(false);
    expect(mockFs.mkdirSync).toHaveBeenCalledWith("/home/test/.claws/session-mcp/abc123", { recursive: true, mode: 0o700 });
    expect(mockFs.chmodSync).toHaveBeenCalledWith("/home/test/.claws/session-mcp/abc123", 0o700);
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      file,
      "# claws-granted: fleet-infra\n# claws-granted: prod-infra\nexport KUBECONFIG='/k/a:/k/b'\n",
      { mode: 0o600 },
    );
    expect(mockFs.chmodSync).toHaveBeenCalledWith(file, 0o600);
  });

  it("finds granted.env only when it carries the capability's exact marker line", () => {
    mockFs.readFileSync.mockReturnValue("# claws-granted: prod-infra-2\n# claws-granted: fleet-infra\nexport KUBECONFIG='/k'\n");
    expect(sessionGrantedEnvFileWith("abc123", "fleet-infra")).toBe("/home/test/.claws/session-mcp/abc123/granted.env");
    expect(mockFs.readFileSync).toHaveBeenCalledWith("/home/test/.claws/session-mcp/abc123/granted.env", "utf8");
    expect(sessionGrantedEnvFileWith("abc123", "prod-infra")).toBeNull();
    mockFs.readFileSync.mockImplementationOnce(() => { throw new Error("ENOENT"); });
    expect(sessionGrantedEnvFileWith("abc123", "fleet-infra")).toBeNull();
  });

  it("removes granted.env best-effort", () => {
    removeSessionGrantedEnvFile("abc123");
    expect(mockFs.rmSync).toHaveBeenCalledWith("/home/test/.claws/session-mcp/abc123/granted.env", { force: true });
    mockFs.rmSync.mockImplementationOnce(() => { throw new Error("EACCES"); });
    expect(() => removeSessionGrantedEnvFile("abc123")).not.toThrow();
  });

  it("returns an absolute path so `.` does not search PATH", () => {
    expect(writeSessionEnvFile("deadbeef", { K: "v" }).startsWith("/")).toBe(true);
  });

  it("escapes single quotes in values", () => {
    writeSessionEnvFile("abc123", { K: "a'b" });
    expect(mockFs.writeFileSync.mock.calls[0][1]).toBe(`export K='a'\\''b'\n`);
  });

  it("writes one export line per var", () => {
    writeSessionEnvFile("abc123", { A: "1", B: "2" });
    expect(mockFs.writeFileSync.mock.calls[0][1]).toBe("export A='1'\nexport B='2'\n");
  });

  it("propagates a write failure to the caller", () => {
    mockFs.writeFileSync.mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    expect(() => writeSessionEnvFile("abc123", { K: "v" })).toThrow("ENOSPC");
  });

  it("removeSessionEnvFile force-removes and never throws", () => {
    mockFs.rmSync.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    expect(() => removeSessionEnvFile("abc123")).not.toThrow();
    expect(mockFs.rmSync).toHaveBeenCalledWith("/home/test/.claws/session-env/abc123.env", {
      force: true,
    });
  });

  it("pruneSessionEnvFiles removes the whole dir and never throws", () => {
    mockFs.rmSync.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    expect(() => pruneSessionEnvFiles()).not.toThrow();
    expect(mockFs.rmSync).toHaveBeenCalledWith(sessionEnvDir(), { recursive: true, force: true });
  });

  it("ensureSessionMcpDir creates and chmods the per-session MCP dir", () => {
    const dir = ensureSessionMcpDir("abc");

    expect(dir).toBe("/home/test/.claws/session-mcp/abc");
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(dir, { recursive: true, mode: 0o700 });
    expect(mockFs.chmodSync).toHaveBeenCalledWith(dir, 0o700);
  });

  it("removeSessionMcpDir force-removes recursively and never throws", () => {
    mockFs.rmSync.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    expect(() => removeSessionMcpDir("abc")).not.toThrow();
    expect(mockFs.rmSync).toHaveBeenCalledWith("/home/test/.claws/session-mcp/abc", {
      recursive: true,
      force: true,
    });
  });

  it("creates a private session Codex home with a minimal config", () => {
    const dir = ensureSessionCodexHome("abc");

    expect(dir).toBe("/home/test/.claws/session-mcp/abc/codex-home");
    expect(sessionCodexHomeDir("abc")).toBe(dir);
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(dir, { recursive: true, mode: 0o700 });
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      "/home/test/.claws/session-mcp/abc/codex-home/config.toml",
      `# Claws session-local Codex config. Ambient plugins and MCP servers are intentionally not inherited.\n${CODEX_DISABLE_UPDATE_CHECK_TOML}\n`,
      { mode: 0o600 },
    );
    expect(mockFs.chmodSync).toHaveBeenCalledWith("/home/test/.claws/session-mcp/abc/codex-home/config.toml", 0o600);
  });

  it("writes escaped Codex developer instructions into the session config", () => {
    const dir = ensureSessionCodexHome("abc", "LINE 1\nquote \" and backslash \\");

    expect(dir).toBe("/home/test/.claws/session-mcp/abc/codex-home");
    const configPath = "/home/test/.claws/session-mcp/abc/codex-home/config.toml";
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      configPath,
      expect.stringContaining("# Claws session-local Codex config. Ambient plugins and MCP servers are intentionally not inherited.\n"),
      { mode: 0o600 },
    );
    const configCall = mockFs.writeFileSync.mock.calls.find((call) => call[0] === configPath);
    expect(configCall).toBeDefined();
    const body = configCall![1] as string;
    expect(body).toContain('developer_instructions = "LINE 1\\nquote \\" and backslash \\\\"');
    expect(body).not.toContain('developer_instructions = "LINE 1\nquote');
    expect(mockFs.chmodSync).toHaveBeenCalledWith(configPath, 0o600);
  });

  it("copies ~/.codex/auth.json into the private Codex home when present", () => {
    mockFs.existsSync.mockReturnValue(true);

    ensureSessionCodexHome("abc");

    expect(mockFs.copyFileSync).toHaveBeenCalledWith(
      "/home/codex/.codex/auth.json",
      "/home/test/.claws/session-mcp/abc/codex-home/auth.json",
    );
    expect(mockFs.chmodSync).toHaveBeenCalledWith(
      "/home/test/.claws/session-mcp/abc/codex-home/auth.json",
      0o600,
    );
  });

  it("skips the auth copy when ~/.codex/auth.json is absent", () => {
    mockFs.existsSync.mockReturnValue(false);

    ensureSessionCodexHome("abc");

    expect(mockFs.copyFileSync).not.toHaveBeenCalled();
    expect(mockFs.rmSync).toHaveBeenCalledWith(
      "/home/test/.claws/session-mcp/abc/codex-home/auth.json",
      { force: true },
    );
  });

  it("writes a session-local OpenCode config pointing at an instructions file", () => {
    const configPath = ensureSessionOpencodeConfig("abc", "PROMPT");

    expect(configPath).toBe("/home/test/.claws/session-mcp/abc/opencode/opencode.json");
    expect(sessionOpencodeDir("abc")).toBe("/home/test/.claws/session-mcp/abc/opencode");

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      "/home/test/.claws/session-mcp/abc/opencode/claws-session-instructions.md",
      "PROMPT\n",
      { mode: 0o600 },
    );

    const configCall = mockFs.writeFileSync.mock.calls.find(
      (call) => call[0] === "/home/test/.claws/session-mcp/abc/opencode/opencode.json",
    );
    expect(configCall).toBeDefined();
    expect(JSON.parse(configCall![1] as string)).toEqual({
      $schema: "https://opencode.ai/config.json",
      instructions: ["/home/test/.claws/session-mcp/abc/opencode/claws-session-instructions.md"],
    });

    expect(mockFs.chmodSync).toHaveBeenCalledWith("/home/test/.claws/session-mcp/abc/opencode", 0o700);
    expect(mockFs.chmodSync).toHaveBeenCalledWith(
      "/home/test/.claws/session-mcp/abc/opencode/claws-session-instructions.md",
      0o600,
    );
    expect(mockFs.chmodSync).toHaveBeenCalledWith(
      "/home/test/.claws/session-mcp/abc/opencode/opencode.json",
      0o600,
    );
  });

  it("prunes orphaned session MCP dirs and keeps active ones", () => {
    mockFs.readdirSync.mockReturnValue([
      { name: "keep-me", isDirectory: () => true },
      { name: "drop-me", isDirectory: () => true },
      { name: "notes.txt", isDirectory: () => false },
    ]);

    pruneOrphanSessionMcpDirs(["keep-me"]);

    expect(mockFs.rmSync).toHaveBeenCalledWith(
      "/home/test/.claws/session-mcp/drop-me",
      { recursive: true, force: true },
    );
    expect(mockFs.rmSync).not.toHaveBeenCalledWith(
      "/home/test/.claws/session-mcp/keep-me",
      { recursive: true, force: true },
    );
  });

  it("swallows prune errors", () => {
    mockFs.readdirSync.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });

    expect(() => pruneOrphanSessionMcpDirs(["keep-me"])).not.toThrow();
  });
});
