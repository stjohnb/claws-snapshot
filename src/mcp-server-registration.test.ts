import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Track tool names registered via server.tool(), and their handlers so tests
// can invoke them directly.
const registeredTools: string[] = [];
const registeredHandlers: Record<string, (args: unknown) => Promise<unknown>> = {};

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    tool(name: string, ..._args: unknown[]) {
      registeredTools.push(name);
      const handler = _args[_args.length - 1];
      if (typeof handler === "function") {
        registeredHandlers[name] = handler as (args: unknown) => Promise<unknown>;
      }
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

  afterEach(() => {
    delete process.env["CLAWS_MCP_SESSION_ID"];
  });

  it("always registers the six core tools", async () => {
    await import("./mcp-server.js");
    expect(registeredTools).toContain("claws_status");
    expect(registeredTools).toContain("claws_task_history");
    expect(registeredTools).toContain("claws_open_prs");
    expect(registeredTools).toContain("claws_config");
    expect(registeredTools).toContain("claws_issue_phases");
    expect(registeredTools).toContain("claws_wait_for_change");
  });

  it("registers claws_set_session_title when CLAWS_MCP_SESSION_ID is set", async () => {
    process.env["CLAWS_MCP_SESSION_ID"] = "abc123";
    await import("./mcp-server.js");
    expect(registeredTools).toContain("claws_set_session_title");
  });

  it("omits claws_set_session_title when CLAWS_MCP_SESSION_ID is unset", async () => {
    delete process.env["CLAWS_MCP_SESSION_ID"];
    await import("./mcp-server.js");
    expect(registeredTools).not.toContain("claws_set_session_title");
  });

  describe("claws_set_session_title handler", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
      process.env["CLAWS_MCP_SESSION_ID"] = "abc123";
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
      fetchMock.mockReset();
      vi.unstubAllGlobals();
    });

    it("POSTs the title as a JSON body to the session's description endpoint", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ description: "New title" }),
      });
      await import("./mcp-server.js");

      const result = (await registeredHandlers["claws_set_session_title"]?.({ title: "New title" })) as {
        content: Array<{ text: string }>;
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://localhost:3000/api/sessions/abc123/description");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      expect(init.body).toBe(JSON.stringify({ description: "New title" }));
      expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: true, title: "New title" });
    });

    it("reports the clear-title note when the API returns an empty description", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ description: null }),
      });
      await import("./mcp-server.js");

      const result = (await registeredHandlers["claws_set_session_title"]?.({ title: "" })) as {
        content: Array<{ text: string }>;
      };

      expect(JSON.parse(result.content[0]!.text)).toEqual({
        ok: true,
        title: null,
        note: "Manual title cleared; automatic summaries resume.",
      });
    });
  });
});
