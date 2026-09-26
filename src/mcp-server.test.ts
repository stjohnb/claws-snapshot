import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// We test the writeClawsMcpConfig helper (the integration point) and the
// /api/state endpoint (the data source for claws_status). The MCP server
// itself is a standalone script that wires these together; its tool handlers
// are thin wrappers around external calls (SQLite, fetch, fs.readFile)
// which are best validated via the build + integration tests.

let mockDatabaseUrl = "";
let mockDatabasePassword = "";

vi.mock("./config.js", () => ({
  WORK_DIR: "/tmp/test-claws",
  CLAUDE_TIMEOUT_MS: 20 * 60 * 1000,
  SERVER_PORT: 3456,
  AUTH_TOKEN: "test-token-abc",
  INTERNAL_MCP_TOKEN: "a".repeat(64),
  get DATABASE_URL() { return mockDatabaseUrl; },
  get DATABASE_PASSWORD() { return mockDatabasePassword; },
  HOME_ASSISTANT_BASE_URL: "https://homeassistant.home.example.net",
  HOME_ASSISTANT_TOKEN: "test-ha-token",
  SESSION_POD_SETTINGS: { mcpUrl: "http://claws.default.svc.cluster.local:3000" },
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
    chmodSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}));

import { writeClawsMcpConfig } from "./claude.js";

const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockChmodSync = vi.mocked(fs.chmodSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockDatabaseUrl = "";
  mockDatabasePassword = "";
});

describe("writeClawsMcpConfig", () => {
  it("writes MCP config with claws-state server", () => {
    const result = writeClawsMcpConfig("/tmp/worktree", { includeHomeAssistant: true });

    expect(result).toBe("/tmp/worktree/.mcp-claws.json");
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    expect(mockChmodSync).toHaveBeenCalledOnce();

    const [filePath, content, options] = mockWriteFileSync.mock.calls[0];
    expect(filePath).toBe("/tmp/worktree/.mcp-claws.json");
    expect(options).toEqual({ mode: 0o600 });

    const chmodCall = mockChmodSync.mock.calls[0];
    expect(chmodCall[0]).toBe("/tmp/worktree/.mcp-claws.json");
    expect(chmodCall[1]).toBe(0o600);

    const config = JSON.parse(content as string);
    expect(config.mcpServers).toHaveProperty("claws-state");
    expect(config.mcpServers["claws-state"].command).toBe(process.execPath);
    expect(path.isAbsolute(config.mcpServers["claws-state"].command)).toBe(true);
    expect(config.mcpServers["claws-state"].args[0]).toMatch(/mcp-server\.js$/);
    const env = config.mcpServers["claws-state"].env;
    expect(env.CLAWS_MCP_WORK_DIR).toBe("/tmp/test-claws");
    expect(env.CLAWS_MCP_PORT).toBe("3456");
    expect(env.CLAWS_MCP_AUTH_TOKEN).toBe("a".repeat(64));
    expect(env.HOME_ASSISTANT_BASE_URL).toBe("https://homeassistant.home.example.net");
    expect(env.HOME_ASSISTANT_TOKEN).toBe("test-ha-token");
  });

  it("passes the Postgres credentials to the MCP child when Claws is on Postgres", () => {
    mockDatabaseUrl = "postgres://claws@db.example:5432/claws";
    mockDatabasePassword = "s3cret";

    writeClawsMcpConfig("/tmp/worktree");

    const [, content] = mockWriteFileSync.mock.calls[0];
    const env = JSON.parse(content as string).mcpServers["claws-state"].env;
    expect(env.CLAWS_DATABASE_URL).toBe("postgres://claws@db.example:5432/claws");
    expect(env.CLAWS_DATABASE_PASSWORD).toBe("s3cret");
  });

  it("points the MCP child at the service's cluster URL and the pod's own token only inside an agent pod", () => {
    writeClawsMcpConfig("/tmp/worktree");
    let env = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string).mcpServers["claws-state"].env;
    expect(env).not.toHaveProperty("CLAWS_MCP_BASE_URL");
    expect(env).not.toHaveProperty("CLAWS_MCP_AUTH_TOKEN_FILE");

    vi.stubEnv("CLAWS_AGENT_POD_ROW", "42");
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === "/etc/claws-workload/mcp-token") return "pod-token\n";
      throw new Error("ENOENT");
    });
    try {
      writeClawsMcpConfig("/tmp/worktree");
      env = JSON.parse(mockWriteFileSync.mock.calls[1][1] as string).mcpServers["claws-state"].env;
      expect(env.CLAWS_MCP_BASE_URL).toBe("http://claws.default.svc.cluster.local:3000");
      // Never the pod process's own per-boot INTERNAL_MCP_TOKEN, which no service knows.
      expect(env.CLAWS_MCP_AUTH_TOKEN_FILE).toBe("/etc/claws-workload/mcp-token");
      expect(env.CLAWS_MCP_AUTH_TOKEN).toBe("pod-token");
    } finally {
      vi.mocked(fs.readFileSync).mockReset();
      vi.unstubAllEnvs();
    }
  });

  it("points the planner tools at the pod's loopback listener inside an agent pod, and warns when it is missing (#clw_01M3A42ZTGECAB11S0BZA6NG1A)", async () => {
    const log = await import("./log.js");
    const plannerRun = { id: "run-1", stage: "plan" as const };

    // In-process: no pod, no planner base URL, whatever the pod variable says.
    vi.stubEnv("CLAWS_PLANNER_RUN_BASE_URL", "http://127.0.0.1:41234");
    writeClawsMcpConfig("/tmp/worktree", { plannerRun });
    let env = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string).mcpServers["claws-state"].env;
    expect(env).not.toHaveProperty("CLAWS_MCP_PLANNER_BASE_URL");

    vi.stubEnv("CLAWS_AGENT_POD_ROW", "42");
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === "/etc/claws-workload/mcp-token") return "pod-token\n";
      throw new Error("ENOENT");
    });
    try {
      writeClawsMcpConfig("/tmp/worktree", { plannerRun });
      env = JSON.parse(mockWriteFileSync.mock.calls[1][1] as string).mcpServers["claws-state"].env;
      expect(env.CLAWS_MCP_PLANNER_BASE_URL).toBe("http://127.0.0.1:41234");
      // Every other HTTP-backed tool still goes to the service.
      expect(env.CLAWS_MCP_BASE_URL).toBe("http://claws.default.svc.cluster.local:3000");
      expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(expect.stringContaining("CLAWS_PLANNER_RUN_BASE_URL"));

      vi.stubEnv("CLAWS_PLANNER_RUN_BASE_URL", "");
      writeClawsMcpConfig("/tmp/worktree", { plannerRun });
      env = JSON.parse(mockWriteFileSync.mock.calls[2][1] as string).mcpServers["claws-state"].env;
      expect(env).not.toHaveProperty("CLAWS_MCP_PLANNER_BASE_URL");
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("CLAWS_PLANNER_RUN_BASE_URL is unset"));

      // A non-planner config in the same pod is silent about it.
      vi.mocked(log.warn).mockClear();
      writeClawsMcpConfig("/tmp/worktree");
      expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(expect.stringContaining("CLAWS_PLANNER_RUN_BASE_URL"));
    } finally {
      vi.mocked(fs.readFileSync).mockReset();
      vi.unstubAllEnvs();
    }
  });

  it("omits the Postgres credentials when Claws is on SQLite", () => {
    writeClawsMcpConfig("/tmp/worktree");

    const [, content] = mockWriteFileSync.mock.calls[0];
    const env = JSON.parse(content as string).mcpServers["claws-state"].env;
    expect(env).not.toHaveProperty("CLAWS_DATABASE_URL");
    expect(env).not.toHaveProperty("CLAWS_DATABASE_PASSWORD");
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

  it("pins claws-state to the running interpreter, not a PATH-resolved 'node' (#2825)", () => {
    writeClawsMcpConfig("/tmp/worktree");

    const [, content] = mockWriteFileSync.mock.calls[0];
    const config = JSON.parse(content as string);
    const command = config.mcpServers["claws-state"].command;

    expect(command).not.toBe("node");
    expect(command).toBe(process.execPath);
    expect(path.isAbsolute(command)).toBe(true);
  });

  it("excludes HA vars when includeHomeAssistant is false", () => {
    writeClawsMcpConfig("/tmp/worktree", { includeHomeAssistant: false });

    const [, content] = mockWriteFileSync.mock.calls[0];
    const config = JSON.parse(content as string);
    const env = config.mcpServers["claws-state"].env;

    expect(env).not.toHaveProperty("HOME_ASSISTANT_BASE_URL");
    expect(env).not.toHaveProperty("HOME_ASSISTANT_TOKEN");
    // Core MCP auth vars must still be present
    expect(env.CLAWS_MCP_AUTH_TOKEN).toBe("a".repeat(64));
    expect(env.CLAWS_MCP_WORK_DIR).toBe("/tmp/test-claws");
    expect(env.CLAWS_MCP_PORT).toBe("3456");
  });

  it("excludes HA vars by default (options omitted)", () => {
    writeClawsMcpConfig("/tmp/worktree");

    const [, content] = mockWriteFileSync.mock.calls[0];
    const config = JSON.parse(content as string);
    const env = config.mcpServers["claws-state"].env;

    expect(env).not.toHaveProperty("HOME_ASSISTANT_BASE_URL");
    expect(env).not.toHaveProperty("HOME_ASSISTANT_TOKEN");
  });

});
