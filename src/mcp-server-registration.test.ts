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

const pgDriverImported = vi.hoisted(() => ({ value: false }));
vi.mock("./db-driver-pg.js", () => {
  pgDriverImported.value = true;
  return { createPgDriver: () => { throw new Error("an agent pod must not open Postgres"); } };
});

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
    delete process.env["CLAWS_MCP_PLANNER_RUN_ID"];
    delete process.env["CLAWS_MCP_PLANNER_STAGE"];
    delete process.env["CLAWS_MCP_PLANNER_OFFERS"];
  });

  it("omits the planner tools when CLAWS_MCP_PLANNER_RUN_ID is unset", async () => {
    process.env["CLAWS_MCP_PLANNER_STAGE"] = "plan";
    await import("./mcp-server.js");
    expect(registeredTools).not.toContain("claws_save_plan");
    expect(registeredTools).not.toContain("claws_report_outcome");
    expect(registeredTools).not.toContain("claws_step_back_verdict");
  });

  it("registers the planner tools for the run's stage when CLAWS_MCP_PLANNER_RUN_ID is set", async () => {
    process.env["CLAWS_MCP_PLANNER_RUN_ID"] = "run-1";
    process.env["CLAWS_MCP_PLANNER_STAGE"] = "plan";
    process.env["CLAWS_MCP_PLANNER_OFFERS"] = "duplicate";
    await import("./mcp-server.js");
    expect(registeredTools).toContain("claws_save_plan");
    expect(registeredTools).toContain("claws_report_outcome");
    expect(registeredTools).not.toContain("claws_step_back_verdict");
  });

  it("registers only claws_step_back_verdict in a step-back run", async () => {
    process.env["CLAWS_MCP_PLANNER_RUN_ID"] = "run-1";
    process.env["CLAWS_MCP_PLANNER_STAGE"] = "step_back";
    await import("./mcp-server.js");
    expect(registeredTools).toContain("claws_step_back_verdict");
    expect(registeredTools).not.toContain("claws_save_plan");
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

  it("registers claws_create_issue and claws_comment_on_issue for headless agents (no CLAWS_MCP_SESSION_ID)", async () => {
    delete process.env["CLAWS_MCP_SESSION_ID"];
    await import("./mcp-server.js");
    expect(registeredTools).toContain("claws_create_issue");
    expect(registeredTools).toContain("claws_comment_on_issue");
  });

  it("registers claws_create_issue and claws_comment_on_issue when CLAWS_MCP_SESSION_ID is set", async () => {
    process.env["CLAWS_MCP_SESSION_ID"] = "abc123";
    await import("./mcp-server.js");
    expect(registeredTools).toContain("claws_create_issue");
    expect(registeredTools).toContain("claws_comment_on_issue");
  });

  it("registers claws_set_session_title and claws_set_session_status when CLAWS_MCP_SESSION_ID is set", async () => {
    process.env["CLAWS_MCP_SESSION_ID"] = "abc123";
    await import("./mcp-server.js");
    expect(registeredTools).toContain("claws_set_session_title");
    expect(registeredTools).toContain("claws_set_session_status");
    expect(registeredTools).toContain("claws_request_capability");
  });

  it("omits claws_set_session_title and claws_set_session_status when CLAWS_MCP_SESSION_ID is unset", async () => {
    delete process.env["CLAWS_MCP_SESSION_ID"];
    await import("./mcp-server.js");
    expect(registeredTools).not.toContain("claws_set_session_title");
    expect(registeredTools).not.toContain("claws_set_session_status");
    expect(registeredTools).not.toContain("claws_request_capability");
  });

  describe("inside an agent pod (CLAWS_MCP_AUTH_TOKEN_FILE set)", () => {
    beforeEach(() => {
      process.env["CLAWS_MCP_AUTH_TOKEN_FILE"] = "/etc/claws-workload/mcp-token";
      process.env["CLAWS_DATABASE_URL"] = "postgres://db/claws";
      pgDriverImported.value = false;
    });

    afterEach(() => {
      delete process.env["CLAWS_MCP_AUTH_TOKEN_FILE"];
      delete process.env["CLAWS_DATABASE_URL"];
    });

    it("reports no database for DB-backed tools without opening Postgres", async () => {
      await import("./mcp-server.js");
      const result = (await registeredHandlers["claws_task_history"]?.({ repo: "org/repo" })) as {
        content: Array<{ text: string }>;
      };
      expect(result.content[0]!.text).toBe(JSON.stringify({ error: "Database not available" }));
      expect(pgDriverImported.value).toBe(false);
    });
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
