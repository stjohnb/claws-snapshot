import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

const INTERNAL_TOKEN = "i".repeat(64);
const SESSION_TOKEN = "s".repeat(64);
const SESSION_ID = "abc123";

vi.mock("./config.js", () => ({
  INTERNAL_MCP_TOKEN: "i".repeat(64),
  SKIPPED_ITEMS: [{ repo: "o/r", number: 1 }],
  PRIORITIZED_ITEMS: [],
}));

vi.mock("./log.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("./db.js", () => ({
  getRunningTaskSummaries: vi.fn(async () => []),
  getMcpTaskHistory: vi.fn(async () => []),
}));

vi.mock("./github.js", () => ({
  listRepos: vi.fn(async () => [{ fullName: "St-John-Software/claws" }]),
  listPRs: vi.fn(async () => []),
}));

// session-backend.ts imports the local backend, which pulls in sessions.ts.
vi.mock("./session-backend-local.js", () => ({ localSessionBackend: {} }));

import { createClawsStateMcpHandler, mcpMethodNotAllowed } from "./claws-state-http.js";
import { getSessionBackend, setSessionBackendForTests, type SessionBackend } from "./session-backend.js";
import { listPRs } from "./github.js";

const setDescription = vi.fn(async (_id: string, description: string) => ({ ok: true, description }));
const setAgentStatus = vi.fn(async (_id: string, status: string) => ({ ok: true, status, updatedAt: 1 }));
let verifyMcpToken: SessionBackend["verifyMcpToken"];

function installBackend(): void {
  setSessionBackendForTests({
    kind: "k8s-pod",
    setDescription,
    setAgentStatus,
    ...(verifyMcpToken ? { verifyMcpToken } : {}),
  } as unknown as SessionBackend);
}

function buildApp(): Hono {
  const app = new Hono();
  // Stand-in for server.ts's apiAuthMiddleware-guarded description route.
  app.post("/api/sessions/:id/description", async (c) => {
    if (c.req.header("authorization") !== `Bearer ${INTERNAL_TOKEN}`) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json() as { description: string };
    const result = await getSessionBackend().setDescription(c.req.param("id"), body.description);
    return c.json({ description: result.description });
  });
  // Stand-in for server.ts's apiAuthMiddleware-guarded status route.
  app.post("/api/sessions/:id/status", async (c) => {
    if (c.req.header("authorization") !== `Bearer ${INTERNAL_TOKEN}`) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json() as { status: "working" | "monitoring" | "waiting" | "done" };
    const result = await getSessionBackend().setAgentStatus(c.req.param("id"), body.status);
    return c.json({ status: result.status, updatedAt: result.updatedAt });
  });
  app.post("/mcp/sessions/:id", createClawsStateMcpHandler(app));
  app.get("/mcp/sessions/:id", () => mcpMethodNotAllowed());
  app.delete("/mcp/sessions/:id", () => mcpMethodNotAllowed());
  return app;
}

let nextId = 1;

function rpc(app: Hono, method: string, params: Record<string, unknown>, token: string | null = SESSION_TOKEN, id = SESSION_ID): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Mcp-Protocol-Version": "2025-06-18",
  };
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  return Promise.resolve(app.request(`/mcp/sessions/${id}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  }));
}

const INIT_PARAMS = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } };

async function callTool(app: Hono, name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await rpc(app, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const body = await res.json() as { result: { content: Array<{ text: string }> } };
  return JSON.parse(body.result.content[0]!.text);
}

describe("claws-state HTTP endpoint", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    verifyMcpToken = vi.fn(async (id: string, token: string) =>
      id === SESSION_ID && token === SESSION_TOKEN ? "ok" as const : "denied" as const);
    installBackend();
    app = buildApp();
  });

  afterEach(() => {
    setSessionBackendForTests(null);
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await rpc(app, "initialize", INIT_PARAMS, null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(verifyMcpToken).not.toHaveBeenCalled();
  });

  it("rejects a wrong token", async () => {
    const res = await rpc(app, "initialize", INIT_PARAMS, "wrong");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects the internal MCP token", async () => {
    const res = await rpc(app, "initialize", INIT_PARAMS, INTERNAL_TOKEN);
    expect(res.status).toBe(401);
  });

  it("rejects a valid token presented for another session", async () => {
    const res = await rpc(app, "initialize", INIT_PARAMS, SESSION_TOKEN, "def456");
    expect(res.status).toBe(401);
  });

  it("rejects everything when the backend has no verifyMcpToken", async () => {
    verifyMcpToken = undefined;
    installBackend();
    const res = await rpc(app, "initialize", INIT_PARAMS);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 503 when the backend cannot answer", async () => {
    verifyMcpToken = vi.fn(async () => "unavailable" as const);
    installBackend();
    const res = await rpc(app, "initialize", INIT_PARAMS);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "session backend unavailable" });
  });

  it("serves initialize and lists exactly the nine claws-state tools", async () => {
    const init = await rpc(app, "initialize", INIT_PARAMS);
    expect(init.status).toBe(200);
    const initBody = await init.json() as { result: { serverInfo: { name: string } } };
    expect(initBody.result.serverInfo.name).toBe("claws-state");

    const list = await rpc(app, "tools/list", {});
    expect(list.status).toBe(200);
    const body = await list.json() as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "claws_config",
      "claws_issue_phases",
      "claws_open_prs",
      "claws_request_capability",
      "claws_set_session_status",
      "claws_set_session_title",
      "claws_status",
      "claws_task_history",
      "claws_wait_for_change",
    ]);
    expect(names.some((n) => n.startsWith("ha_"))).toBe(false);
  });

  it("claws_set_session_title retitles the session named in the URL", async () => {
    expect(await callTool(app, "claws_set_session_title", { title: "Pod work" })).toEqual({ ok: true, title: "Pod work" });
    expect(setDescription).toHaveBeenCalledWith(SESSION_ID, "Pod work");
  });

  it("claws_set_session_status sets the status of the session named in the URL", async () => {
    expect(await callTool(app, "claws_set_session_status", { status: "monitoring" })).toEqual({ ok: true, status: "monitoring" });
    expect(setAgentStatus).toHaveBeenCalledWith(SESSION_ID, "monitoring");
  });

  it("claws_config returns the loaded config's lists", async () => {
    expect(await callTool(app, "claws_config", {})).toEqual({
      skippedItems: [{ repo: "o/r", number: 1 }],
      prioritizedItems: [],
    });
  });

  it("claws_open_prs refuses a repo Claws does not manage", async () => {
    const result = await callTool(app, "claws_open_prs", { repo: "someone/else" }) as { error: string };
    expect(result.error).toContain("someone/else is not a repo Claws manages");
    expect(listPRs).not.toHaveBeenCalled();
  });

  it("claws_open_prs projects PRs for a managed repo", async () => {
    vi.mocked(listPRs).mockResolvedValueOnce([{
      number: 7, title: "t", headRefName: "b", baseRefName: "main", labels: [{ name: "x" }],
      author: { login: "a" }, updatedAt: "2026-09-14T00:00:00Z", isDraft: false, body: "secret body",
    }]);
    expect(await callTool(app, "claws_open_prs", { repo: "St-John-Software/claws" })).toEqual([{
      number: 7, title: "t", headRefName: "b", labels: [{ name: "x" }],
      author: { login: "a" }, updatedAt: "2026-09-14T00:00:00Z", isDraft: false,
    }]);
  });

  it("claws_open_prs matches a managed repo name case-insensitively", async () => {
    vi.mocked(listPRs).mockResolvedValueOnce([]);
    expect(await callTool(app, "claws_open_prs", { repo: "st-john-software/CLAWS" })).toEqual([]);
    expect(listPRs).toHaveBeenCalledWith("St-John-Software/claws");
  });

  it("returns 405 for GET and DELETE", async () => {
    expect((await app.request(`/mcp/sessions/${SESSION_ID}`)).status).toBe(405);
    expect((await app.request(`/mcp/sessions/${SESSION_ID}`, { method: "DELETE" })).status).toBe(405);
  });
});
