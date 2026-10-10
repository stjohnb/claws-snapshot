/**
 * The `claws-state` MCP server over streamable HTTP, served by the Claws
 * service itself at `/mcp/sessions/:id` (#3056). It serves every interactive
 * session — each session pod reaches it through the in-cluster URL. Session
 * pods cannot run the stdio `mcp-server.ts`, which needs database
 * credentials and `INTERNAL_MCP_TOKEN`, and neither may enter a pod; that
 * stdio server now serves headless agents, planner and requirements runs only.
 *
 * Every request authenticates with the per-session bearer token the session
 * backend issued for the id in the URL — never `INTERNAL_MCP_TOKEN` or an OIDC
 * cookie — and the tools only ever act as that session. Stateless: each POST
 * gets a fresh server and transport, answering in JSON response mode — except
 * that a session launched under an older Claws `VERSION` gets its first
 * `tools/call` per process answered over SSE, preceded by
 * `notifications/tools/list_changed`. The Home Assistant tools are never registered
 * here.
 */

import type { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as config from "./config.js";
import { getPersistedSession, getMcpRecentJobLogs, getMcpRecentJobRuns, getMcpRepoProcessingState, getMcpTaskHistory, getMcpWorkQueue, getRunningTaskSummaries } from "./db.js";
import { listPRs, listRepos } from "./github.js";
import { getSessionBackend } from "./session-backend.js";
import { sessionUpgradedSince } from "./session-upgrade.js";
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

/**
 * In-process call to a Claws API route with a given bearer, never leaving
 * this process. Shared by `fetchApi` (the internal token) and
 * `fetchSessionApi` (this session's own verified token).
 */
async function callApi(app: InProcessApp, bearer: string, pathAndQuery: string, timeoutMs: number, init?: { method: string; body: unknown }): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
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
}

function buildDeps(app: InProcessApp, sessionId: string, sessionToken: string): ClawsStateToolDeps {
  return {
    runningTasks: () => getRunningTaskSummaries(),
    taskHistory: (repo, itemNumber) => getMcpTaskHistory(repo, itemNumber),
    recentJobRuns: (limit, jobName) => getMcpRecentJobRuns(limit, jobName),
    recentJobLogs: (opts) => getMcpRecentJobLogs(opts),
    workQueue: (opts) => getMcpWorkQueue(opts.limit, opts.statuses),
    repoProcessingState: (opts) => getMcpRepoProcessingState(opts),
    openPrs: async (repo) => {
      const prs = await listOpenPrsForManagedRepo(repo);
      if (!prs) {
        throw new Error(`${repo} is not a repo Claws manages`);
      }
      return prs;
    },
    // The internal token authenticates against apiAuthMiddleware.
    fetchApi: (pathAndQuery, timeoutMs, init) => callApi(app, config.INTERNAL_MCP_TOKEN, pathAndQuery, timeoutMs, init),
    // The session gate-write routes refuse the internal token
    // (#clw_01M3BWP83BQRXE06NWW1GKYT2S): this forwards the same per-session
    // bearer `createClawsStateMcpHandler` already verified for this request.
    fetchSessionApi: (pathAndQuery, timeoutMs, init) => callApi(app, sessionToken, pathAndQuery, timeoutMs, init),
    configSnapshot: async () => ({
      skippedItems: [...config.SKIPPED_ITEMS],
      prioritizedItems: [...config.PRIORITIZED_ITEMS],
    }),
    sessionId,
  };
}

/**
 * Sessions already sent `notifications/tools/list_changed` by this process.
 * In memory, so each server process announces an upgrade at most once per
 * session; a restart re-announces, which is harmless.
 */
const announced = new Set<string>();

/** True when the parsed JSON-RPC body (one message or a batch) holds a `tools/call` request. */
function hasToolsCall(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((m) => typeof m === "object" && m !== null && (m as { method?: unknown }).method === "tools/call");
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

    // A session launched under an older Claws listed its tools before this
    // version's were registered: tell it once, on the first tool call's own
    // SSE stream, that the list changed.
    let launchedVersion: string | null = null;
    try {
      launchedVersion = (await getPersistedSession(id))?.launched_version ?? null;
    } catch (err) {
      log.warn(`[claws-state-http] Cannot read session ${id}'s launch version: ${err}`);
    }
    const announce = sessionUpgradedSince(launchedVersion) && !announced.has(id)
      && hasToolsCall(await c.req.raw.clone().json().catch(() => null));

    const server = new McpServer({ name: "claws-state", version: "1.0.0" });
    registerClawsStateTools(server, buildDeps(app, id, token));
    // Related notifications reach the client only in SSE mode; JSON response
    // mode drops them, so only the announcing request switches.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: !announce,
    });
    const closeServer = () => server.close().catch((err) => log.warn(`[claws-state-http] close failed: ${err}`));
    let closeOnDrain = false;
    try {
      await server.connect(transport);
      if (announce) {
        const dispatch = transport.onmessage;
        transport.onmessage = (msg, extra) => {
          if ("id" in msg && "method" in msg) {
            void server.server.notification({ method: "notifications/tools/list_changed" }, { relatedRequestId: msg.id })
              .catch((err) => log.warn(`[claws-state-http] list_changed for session ${id} failed: ${err}`));
            announced.add(id);
          }
          dispatch?.(msg, extra);
        };
      }
      const res = await transport.handleRequest(c.req.raw);
      if (!announce || !res.body || !res.headers.get("content-type")?.startsWith("text/event-stream")) return res;
      // SSE mode returns before the tool has answered: close the server only
      // once the stream has drained (or the client went away).
      closeOnDrain = true;
      const drained = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        flush: () => { void closeServer(); },
        cancel: () => { void closeServer(); },
      }));
      return new Response(drained, { status: res.status, headers: res.headers });
    } finally {
      // JSON response mode resolves only once every response is ready, so
      // nothing is still in flight here.
      if (!closeOnDrain) await closeServer();
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
