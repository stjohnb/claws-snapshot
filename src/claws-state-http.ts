/**
 * The `claws-state` MCP server over streamable HTTP, served by the Claws
 * service itself at `/mcp/sessions/:id` (#3056). It is for session pods, which
 * cannot run the stdio `mcp-server.ts`: that needs database credentials and
 * `INTERNAL_MCP_TOKEN`, and neither may enter a pod.
 *
 * Every request authenticates with the per-session bearer token the session
 * backend issued for the id in the URL — never `INTERNAL_MCP_TOKEN` or an OIDC
 * cookie — and the tools only ever act as that session. Stateless: each POST
 * gets a fresh server and transport. The Home Assistant tools are never
 * registered here.
 */

import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as config from "./config.js";
import { getMcpTaskHistory, getRunningTaskSummaries } from "./db.js";
import { listPRs, listRepos } from "./github.js";
import { getSessionBackend } from "./session-backend.js";
import { registerClawsStateTools, type ClawsStateToolDeps } from "./claws-state-tools.js";
import * as log from "./log.js";

/** The part of the Hono app the tools need: in-process dispatch to the existing API routes. */
export interface InProcessApp {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

/** The projected PR shape both claws-state servers return from `claws_open_prs`. */
export interface OpenPrSummary {
  number: number;
  title: string;
  headRefName: string;
  labels: { name: string }[];
  author: { login: string };
  updatedAt?: string;
  isDraft?: boolean;
}

/**
 * Open PRs for `repo`, or `null` if it is not a repo Claws manages. The App
 * installation token reaches repos outside the managed set, so a caller must
 * not be able to list PRs on any installed repo — shared by the in-process
 * HTTP variant and the `/api/open-prs` route the stdio server calls (#3062).
 */
export async function listOpenPrsForManagedRepo(repo: string): Promise<OpenPrSummary[] | null> {
  const repos = await listRepos();
  const wanted = repo.toLowerCase();
  const managed = repos.find((r) => r.fullName.toLowerCase() === wanted);
  if (!managed) return null;
  const prs = await listPRs(managed.fullName);
  return prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    labels: pr.labels,
    author: pr.author,
    updatedAt: pr.updatedAt,
    isDraft: pr.isDraft,
  }));
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function buildDeps(app: InProcessApp, sessionId: string): ClawsStateToolDeps {
  return {
    runningTasks: () => getRunningTaskSummaries(),
    taskHistory: (repo, itemNumber) => getMcpTaskHistory(repo, itemNumber),
    openPrs: async (repo) => {
      const prs = await listOpenPrsForManagedRepo(repo);
      if (!prs) {
        throw new Error(`${repo} is not a repo Claws manages`);
      }
      return prs;
    },
    fetchApi: async (pathAndQuery, timeoutMs, init) => {
      // In process: the internal token authenticates against apiAuthMiddleware
      // but never leaves this process.
      const headers: Record<string, string> = { Authorization: `Bearer ${config.INTERNAL_MCP_TOKEN}` };
      const reqInit: RequestInit = { headers, signal: AbortSignal.timeout(timeoutMs) };
      if (init) {
        headers["Content-Type"] = "application/json";
        reqInit.method = init.method;
        reqInit.body = JSON.stringify(init.body);
      }
      const res = await app.request(pathAndQuery, reqInit);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        const detail = typeof body?.error === "string" ? `: ${body.error}` : "";
        throw new Error(`HTTP ${res.status}${detail}`);
      }
      return res.json();
    },
    configSnapshot: async () => ({
      skippedItems: [...config.SKIPPED_ITEMS],
      prioritizedItems: [...config.PRIORITIZED_ITEMS],
    }),
    sessionId,
  };
}

/** Build the POST handler for `/mcp/sessions/:id`. Does its own auth — mount it without any auth middleware. */
export function createClawsStateMcpHandler(app: InProcessApp): (c: Context) => Promise<Response> {
  return async (c) => {
    const id = c.req.param("id") ?? "";
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const backend = getSessionBackend();
    if (!/^[a-f0-9]+$/.test(id) || !token || !backend.verifyMcpToken) return unauthorized();

    const verdict = await backend.verifyMcpToken(id, token);
    if (verdict === "unavailable") {
      return Response.json({ error: "session backend unavailable" }, { status: 503 });
    }
    if (verdict !== "ok") return unauthorized();

    const server = new McpServer({ name: "claws-state", version: "1.0.0" });
    registerClawsStateTools(server, buildDeps(app, id));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      // JSON response mode resolves only once every response is ready, so
      // nothing is still in flight here.
      await server.close().catch((err) => log.warn(`[claws-state-http] close failed: ${err}`));
    }
  };
}

/** GET/DELETE on `/mcp/sessions/:id`: stateless, so there is no SSE stream or session to end. */
export function mcpMethodNotAllowed(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
    { status: 405, headers: { Allow: "POST" } },
  );
}
