import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

describe("namey_query conditional registration", () => {
  const origEnv = process.env["NAMEY_DB_URL"];

  beforeEach(() => {
    registeredTools.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env["NAMEY_DB_URL"] = origEnv;
    } else {
      delete process.env["NAMEY_DB_URL"];
    }
  });

  it("registers namey_query tool when NAMEY_DB_URL is set", async () => {
    process.env["NAMEY_DB_URL"] = "postgresql://readonly:pass@db.example.com:5432/names";
    await import("./mcp-server.js");
    expect(registeredTools).toContain("namey_query");
  });

  it("does not register namey_query tool when NAMEY_DB_URL is empty", async () => {
    process.env["NAMEY_DB_URL"] = "";
    await import("./mcp-server.js");
    expect(registeredTools).not.toContain("namey_query");
  });

  it("does not register namey_query tool when NAMEY_DB_URL is unset", async () => {
    delete process.env["NAMEY_DB_URL"];
    await import("./mcp-server.js");
    expect(registeredTools).not.toContain("namey_query");
  });

  it("always registers the four core tools", async () => {
    process.env["NAMEY_DB_URL"] = "";
    await import("./mcp-server.js");
    expect(registeredTools).toContain("claws_status");
    expect(registeredTools).toContain("claws_task_history");
    expect(registeredTools).toContain("claws_open_prs");
    expect(registeredTools).toContain("claws_config");
  });
});
