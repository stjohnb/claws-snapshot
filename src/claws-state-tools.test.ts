import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerClawsStateTools, type ClawsStateToolDeps } from "./claws-state-tools.js";

function makeDeps(overrides: Partial<ClawsStateToolDeps> = {}): ClawsStateToolDeps {
  return {
    runningTasks: vi.fn(async () => []),
    taskHistory: vi.fn(async () => []),
    openPrs: vi.fn(async () => []),
    fetchApi: vi.fn(async () => ({})),
    configSnapshot: vi.fn(async () => ({ skippedItems: [], prioritizedItems: [] })),
    sessionId: "",
    ...overrides,
  };
}

async function connect(deps: ClawsStateToolDeps): Promise<Client> {
  const server = new McpServer({ name: "claws-state", version: "1.0.0" });
  registerClawsStateTools(server, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text);
}

describe("registerClawsStateTools", () => {
  it("registers only the six core tools without a sessionId", async () => {
    const client = await connect(makeDeps());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "claws_config",
      "claws_issue_phases",
      "claws_open_prs",
      "claws_status",
      "claws_task_history",
      "claws_wait_for_change",
    ]);
  });

  it("registers claws_set_session_title when a sessionId is given, scoped to that session", async () => {
    const fetchApi = vi.fn(async () => ({ description: "Hi" }));
    const client = await connect(makeDeps({ sessionId: "abc123", fetchApi }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("claws_set_session_title");

    expect(await callJson(client, "claws_set_session_title", { title: "Hi" })).toEqual({ ok: true, title: "Hi" });
    expect(fetchApi).toHaveBeenCalledWith(
      "/api/sessions/abc123/description",
      5000,
      { method: "POST", body: { description: "Hi" } },
    );
  });

  it("registers claws_set_session_status only with a sessionId, POSTing to that session's status route", async () => {
    const without = await connect(makeDeps());
    expect((await without.listTools()).tools.map((t) => t.name)).not.toContain("claws_set_session_status");

    const fetchApi = vi.fn(async () => ({ status: "monitoring", updatedAt: 1 }));
    const client = await connect(makeDeps({ sessionId: "abc123", fetchApi }));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("claws_set_session_status");

    expect(await callJson(client, "claws_set_session_status", { status: "monitoring" })).toEqual({ ok: true, status: "monitoring" });
    expect(fetchApi).toHaveBeenCalledWith(
      "/api/sessions/abc123/status",
      5000,
      { method: "POST", body: { status: "monitoring" } },
    );
  });

  it("claws_set_session_status rejects a status outside the enum without calling the API", async () => {
    const fetchApi = vi.fn(async () => ({}));
    const client = await connect(makeDeps({ sessionId: "abc123", fetchApi }));
    const result = await client.callTool({ name: "claws_set_session_status", arguments: { status: "busy" } }) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("claws_set_session_status reports an API failure", async () => {
    const client = await connect(makeDeps({
      sessionId: "abc123",
      fetchApi: vi.fn(async () => { throw new Error("HTTP 404: Session not found"); }),
    }));
    expect(await callJson(client, "claws_set_session_status", { status: "done" })).toEqual({
      error: "Set status failed: HTTP 404: Session not found",
    });
  });

  describe("claws_request_capability (#3072)", () => {
    const BASE = "/api/sessions/abc123/capability-requests";

    it("is registered only with a sessionId", async () => {
      const without = await connect(makeDeps());
      expect((await without.listTools()).tools.map((t) => t.name)).not.toContain("claws_request_capability");
      const client = await connect(makeDeps({ sessionId: "abc123" }));
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("claws_request_capability");
    });

    it("POSTs the request, polls until granted, and returns usage plus how to load it", async () => {
      const fetchApi = vi.fn()
        .mockResolvedValueOnce({ status: "pending", capability: "prod-infra" })
        .mockResolvedValueOnce({ status: "pending", capability: "prod-infra" })
        .mockResolvedValueOnce({
          status: "granted", capability: "prod-infra", description: "kubectl access to the production Kubernetes cluster.",
          loadPath: "/home/claws/granted.env", live: true, marker: "# claws-granted: prod-infra", delayed: false,
        });
      const sleep = vi.fn(async () => {});
      const client = await connect(makeDeps({ sessionId: "abc123", fetchApi, sleep }));
      const result = await callJson(client, "claws_request_capability", { capability: "prod-infra", reason: "check pods" });
      expect(fetchApi).toHaveBeenNthCalledWith(1, BASE, 10_000, { method: "POST", body: { capability: "prod-infra", reason: "check pods" } });
      expect(fetchApi).toHaveBeenNthCalledWith(2, `${BASE}/prod-infra`, 10_000);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        status: "granted",
        capability: "prod-infra",
        usage: "kubectl access to the production Kubernetes cluster.",
        load: "Each Bash call is a fresh shell — prefix commands that need it with `. /home/claws/granted.env && `.",
      });
    });

    it("tells a pod session the mounted file can lag, and never includes a secret value", async () => {
      const fetchApi = vi.fn(async () => ({
        status: "granted", capability: "prod-infra", description: "kubectl.", loadPath: "/etc/claws-workload/granted-env",
        live: true, marker: "# claws-granted: prod-infra", delayed: true,
      }));
      const client = await connect(makeDeps({ sessionId: "abc123", fetchApi }));
      const result = await callJson(client, "claws_request_capability", { capability: "prod-infra", reason: "r" }) as { load: string };
      expect(result.load).toContain("up to 2 minutes");
      expect(result.load).toContain("grep -qxF '# claws-granted: prod-infra' /etc/claws-workload/granted-env");
      expect(Object.keys(result).sort()).toEqual(["capability", "load", "status", "usage"]);
    });

    it("says a grant to a pod without slots takes effect on resume", async () => {
      const fetchApi = vi.fn(async () => ({ status: "granted", description: "d", loadPath: null, live: false }));
      const client = await connect(makeDeps({ sessionId: "abc123", fetchApi }));
      const result = await callJson(client, "claws_request_capability", { capability: "prod-infra", reason: "r" }) as { load: string };
      expect(result.load).toBe("Granted; effective after the user resumes the session.");
    });

    it("reports a denial and tells the agent not to ask again", async () => {
      const client = await connect(makeDeps({ sessionId: "abc123", fetchApi: vi.fn(async () => ({ status: "denied" })) }));
      expect(await callJson(client, "claws_request_capability", { capability: "prod-infra", reason: "r" })).toEqual({
        status: "denied",
        capability: "prod-infra",
        note: "The user denied this request. Do not request it again unless the user asks.",
      });
    });

    it("returns pending without polling when timeout_seconds is 0", async () => {
      const fetchApi = vi.fn(async () => ({ status: "pending" }));
      const sleep = vi.fn(async () => {});
      const client = await connect(makeDeps({ sessionId: "abc123", fetchApi, sleep }));
      const result = await callJson(client, "claws_request_capability", { capability: "prod-infra", reason: "r", timeout_seconds: 0 }) as { status: string; note: string };
      expect(result.status).toBe("pending");
      expect(result.note).toContain("approve it on this session's Claws page");
      expect(fetchApi).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("reports an API rejection", async () => {
      const client = await connect(makeDeps({
        sessionId: "abc123",
        fetchApi: vi.fn(async () => { throw new Error("HTTP 400: browser is not requestable for this session. Requestable: prod-infra"); }),
      }));
      expect(await callJson(client, "claws_request_capability", { capability: "browser", reason: "r" })).toEqual({
        error: "Capability request failed: HTTP 400: browser is not requestable for this session. Requestable: prod-infra",
      });
    });
  });

  it("claws_status still returns running tasks when the API dep throws", async () => {
    const rows = [{ job_name: "issue-worker", repo: "o/r", item_number: 1, started_at: "t" }];
    const client = await connect(makeDeps({
      fetchApi: vi.fn(async () => { throw new Error("HTTP 500: boom"); }),
      runningTasks: vi.fn(async () => rows),
    }));
    expect(await callJson(client, "claws_status")).toEqual({
      queueError: "Queue data unavailable: HTTP 500: boom",
      runningTasks: rows,
    });
  });

  it("claws_status reports runningTasksError when the DB query throws, and omits runningTasks with no DB", async () => {
    const failing = await connect(makeDeps({
      fetchApi: vi.fn(async () => ({ queue: [] })),
      runningTasks: vi.fn(async () => { throw new Error("locked"); }),
    }));
    expect(await callJson(failing, "claws_status")).toEqual({
      queue: { queue: [] },
      runningTasksError: "DB query failed: locked",
    });

    const noDb = await connect(makeDeps({ runningTasks: vi.fn(async () => null) }));
    expect(await callJson(noDb, "claws_status")).toEqual({ queue: {} });
  });

  it("claws_task_history reports a missing database", async () => {
    const client = await connect(makeDeps({ taskHistory: vi.fn(async () => null) }));
    expect(await callJson(client, "claws_task_history", { repo: "o/r" })).toEqual({ error: "Database not available" });
  });

  it("claws_open_prs reports an openPrs rejection with the new error prefix", async () => {
    const client = await connect(makeDeps({
      openPrs: vi.fn(async () => { throw new Error("someone/else is not a repo Claws manages"); }),
    }));
    expect(await callJson(client, "claws_open_prs", { repo: "someone/else" })).toEqual({
      error: "Open PR lookup failed: someone/else is not a repo Claws manages",
    });
  });
});
