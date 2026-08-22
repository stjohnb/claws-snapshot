import { describe, it, expect, vi, beforeEach } from "vitest";

// Track tool names registered via server.tool()
const registeredTools: string[] = [];

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    tool(name: string, ..._args: unknown[]) {
      registeredTools.push(name);
    }
    async connect() {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

vi.mock("better-sqlite3", () => ({
  default: class {
    prepare() {
      return { all: () => [] };
    }
    close() {}
  },
}));

const zodProxy: unknown = new Proxy(() => zodProxy, {
  get: () => zodProxy,
  apply: () => zodProxy,
});
vi.mock("zod", () => ({ z: zodProxy }));

describe("mcp-server tool registration", () => {
  beforeEach(() => {
    registeredTools.length = 0;
    vi.resetModules();
  });

  it("always registers the four core tools", async () => {
    await import("./mcp-server.js");
    expect(registeredTools).toContain("claws_status");
    expect(registeredTools).toContain("claws_task_history");
    expect(registeredTools).toContain("claws_open_prs");
    expect(registeredTools).toContain("claws_config");
  });
});
