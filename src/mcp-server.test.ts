import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// We test the writeClawsMcpConfig helper (the integration point) and the
// /api/state endpoint (the data source for claws_status). The MCP server
// itself is a standalone script that wires these together; its tool handlers
// are thin wrappers around external calls (SQLite, fetch, gh CLI, fs.readFile)
// which are best validated via the build + integration tests.

vi.mock("./config.js", () => ({
  WORK_DIR: "/tmp/test-claws",
  CLAUDE_TIMEOUT_MS: 20 * 60 * 1000,
  SERVER_PORT: 3456,
  AUTH_TOKEN: "test-token-abc",
  INTERNAL_MCP_TOKEN: "a".repeat(64),
  NAMEY_DB_URL: "postgresql://readonly:pass@db.example.com:5432/names",
  HOME_ASSISTANT_BASE_URL: "https://homeassistant.home.example.net",
  HOME_ASSISTANT_TOKEN: "test-ha-token",
}));

vi.mock("./log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./shutdown.js", () => ({
  isShuttingDown: () => false,
  ShutdownError: class extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "ShutdownError";
    }
  },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

import { writeClawsMcpConfig } from "./claude.js";

const mockWriteFileSync = vi.mocked(fs.writeFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("writeClawsMcpConfig", () => {
  it("writes MCP config with claws-state server", () => {
    const result = writeClawsMcpConfig("/tmp/worktree");

    expect(result).toBe("/tmp/worktree/.mcp-claws.json");
    expect(mockWriteFileSync).toHaveBeenCalledOnce();

    const [filePath, content] = mockWriteFileSync.mock.calls[0];
    expect(filePath).toBe("/tmp/worktree/.mcp-claws.json");

    const config = JSON.parse(content as string);
    expect(config.mcpServers).toHaveProperty("claws-state");
    expect(config.mcpServers["claws-state"].command).toBe("node");
    expect(config.mcpServers["claws-state"].args[0]).toMatch(/mcp-server\.js$/);
    const env = config.mcpServers["claws-state"].env;
    expect(env.CLAWS_MCP_WORK_DIR).toBe("/tmp/test-claws");
    expect(env.CLAWS_MCP_PORT).toBe("3456");
    expect(env.CLAWS_MCP_AUTH_TOKEN).toBe("a".repeat(64));
    expect(env.NAMEY_DB_URL).toBe("postgresql://readonly:pass@db.example.com:5432/names");
    expect(env.HOME_ASSISTANT_BASE_URL).toBe("https://homeassistant.home.example.net");
    expect(env.HOME_ASSISTANT_TOKEN).toBe("test-ha-token");
  });

  it("merges additional servers", () => {
    writeClawsMcpConfig("/tmp/worktree", {
      additionalServers: {
        playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
      },
    });

    const [, content] = mockWriteFileSync.mock.calls[0];
    const config = JSON.parse(content as string);

    expect(config.mcpServers).toHaveProperty("claws-state");
    expect(config.mcpServers).toHaveProperty("playwright");
    expect(config.mcpServers.playwright.command).toBe("npx");
    expect(config.mcpServers.playwright.args).toEqual(["@playwright/mcp@latest"]);
  });

  it("passes NAMEY_DB_URL when configured", () => {
    writeClawsMcpConfig("/tmp/worktree");

    const [, content] = mockWriteFileSync.mock.calls[0];
    const config = JSON.parse(content as string);
    expect(config.mcpServers["claws-state"].env.NAMEY_DB_URL).toBe(
      "postgresql://readonly:pass@db.example.com:5432/names",
    );
  });

  it("omits NAMEY_DB_URL when empty", async () => {
    const configMod = await import("./config.js");
    const original = configMod.NAMEY_DB_URL;
    (configMod as Record<string, unknown>).NAMEY_DB_URL = "";

    try {
      writeClawsMcpConfig("/tmp/worktree");
      const [, content] = mockWriteFileSync.mock.calls[0];
      const config = JSON.parse(content as string);
      expect(config.mcpServers["claws-state"].env).not.toHaveProperty("NAMEY_DB_URL");
    } finally {
      (configMod as Record<string, unknown>).NAMEY_DB_URL = original;
    }
  });

  it("excludes NAMEY_DB_URL and HA vars when includeNameyDb/includeHomeAssistant are false", () => {
    writeClawsMcpConfig("/tmp/worktree", { includeNameyDb: false, includeHomeAssistant: false });

    const [, content] = mockWriteFileSync.mock.calls[0];
    const config = JSON.parse(content as string);
    const env = config.mcpServers["claws-state"].env;

    expect(env).not.toHaveProperty("NAMEY_DB_URL");
    expect(env).not.toHaveProperty("HOME_ASSISTANT_BASE_URL");
    expect(env).not.toHaveProperty("HOME_ASSISTANT_TOKEN");
    // Core MCP auth vars must still be present
    expect(env.CLAWS_MCP_AUTH_TOKEN).toBe("a".repeat(64));
    expect(env.CLAWS_MCP_WORK_DIR).toBe("/tmp/test-claws");
    expect(env.CLAWS_MCP_PORT).toBe("3456");
  });

  it("includes NAMEY_DB_URL and HA vars by default (options omitted)", () => {
    writeClawsMcpConfig("/tmp/worktree");

    const [, content] = mockWriteFileSync.mock.calls[0];
    const config = JSON.parse(content as string);
    const env = config.mcpServers["claws-state"].env;

    expect(env.NAMEY_DB_URL).toBe("postgresql://readonly:pass@db.example.com:5432/names");
    expect(env.HOME_ASSISTANT_BASE_URL).toBe("https://homeassistant.home.example.net");
    expect(env.HOME_ASSISTANT_TOKEN).toBe("test-ha-token");
  });

});
