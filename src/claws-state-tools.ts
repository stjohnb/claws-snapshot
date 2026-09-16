/**
 * The `claws-state` MCP tools, shared by the stdio server (`mcp-server.ts`,
 * spawned per session on the host) and the in-service streamable HTTP server
 * (`claws-state-http.ts`, for k8s-pod sessions) so the two cannot drift.
 *
 * A deliberate leaf: every data source arrives through
 * {@link ClawsStateToolDeps}, and this module imports only the SDK type, `zod`
 * and `mcp-result.js`. `mcp-server.ts` runs as a standalone child process, so a
 * `config`/`db`/`github` import here would drag the whole service into it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResult, errorResult } from "./mcp-result.js";

const PrListSchema = z.array(z.object({
  number: z.number(),
  title: z.string(),
  headRefName: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  author: z.object({ login: z.string() }),
  updatedAt: z.string(),
  isDraft: z.boolean(),
}));

export interface ClawsStateToolDeps {
  /**
   * `status = 'running'` tasks (`job_name, repo, item_number, started_at`), or
   * null when there is no database — `claws_status` then omits `runningTasks`.
   * A throw is reported as `runningTasksError`.
   */
  runningTasks(): Promise<unknown[] | null>;
  /** Last 20 tasks for a repo (optionally one item), or null when there is no database. */
  taskHistory(repo: string, itemNumber?: number): Promise<unknown[] | null>;
  /**
   * Open PRs with `number,title,headRefName,labels,author,updatedAt,isDraft`.
   * Must be forge-aware (GitHub and Forgejo) and limited to repos Claws
   * manages.
   */
  openPrs(repo: string): Promise<unknown>;
  /** Call a Claws API route; resolves to the parsed JSON body or throws `HTTP <status>: <error>`. */
  fetchApi(pathAndQuery: string, timeoutMs: number, init?: { method: string; body: unknown }): Promise<unknown>;
  /** The operator's skip and priority lists. */
  configSnapshot(): Promise<{ skippedItems: unknown[]; prioritizedItems: unknown[] }>;
  /** The interactive session these tools act for; empty registers no `claws_set_session_title` / `claws_set_session_status` / `claws_request_capability`. */
  sessionId: string;
  /** Wait between `claws_request_capability` status polls; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Register the six core claws-state tools, plus the session tools (`claws_set_session_title`, `claws_set_session_status`, `claws_request_capability`) when `deps.sessionId` is set. */
export function registerClawsStateTools(server: McpServer, deps: ClawsStateToolDeps): void {
  // Tool: claws_status
  server.tool(
    "claws_status",
    // Claude queue entries come from /api/state (includes claudeQueueEntries).
    "Get current Claws operational status: running tasks, queue items by category, Claude queue pending/active counts, and Claude queue entries with position and metadata",
    {},
    async () => {
      const parts: Record<string, unknown> = {};

      // HTTP state (queue + claude queue)
      try {
        parts.queue = await deps.fetchApi("/api/state", 5000);
      } catch (err) {
        parts.queueError = `Queue data unavailable: ${err instanceof Error ? err.message : err}`;
      }

      // DB running tasks
      try {
        const rows = await deps.runningTasks();
        if (rows) parts.runningTasks = rows;
      } catch (err) {
        parts.runningTasksError = `DB query failed: ${err instanceof Error ? err.message : err}`;
      }

      return textResult(parts);
    },
  );

  // Tool: claws_task_history
  server.tool(
    "claws_task_history",
    "Get recent task history for a repository, optionally filtered by issue/PR number. Shows job name, status, errors, and timestamps.",
    {
      repo: z.string().describe("Repository full name (e.g. 'owner/repo')"),
      item_number: z.number().optional().describe("Optional issue or PR number to filter by"),
    },
    async ({ repo, item_number }) => {
      try {
        const rows = await deps.taskHistory(repo, item_number);
        if (!rows) {
          return errorResult("Database not available");
        }
        return textResult(rows);
      } catch (err) {
        return errorResult(`DB query failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  );

  // Tool: claws_open_prs
  server.tool(
    "claws_open_prs",
    "List open pull requests for a repository with number, title, branch, author, labels, and draft status",
    {
      repo: z.string().describe("Repository full name (e.g. 'owner/repo')"),
    },
    async ({ repo }) => {
      try {
        const prs = PrListSchema.parse(await deps.openPrs(repo));
        return textResult(prs);
      } catch (err) {
        return errorResult(`Open PR lookup failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  );

  // Tool: claws_issue_phases
  // Deliberately goes over the API rather than computing coverage here: the
  // stdio server is a standalone process and must not pull in the Claws
  // config/DB/GitHub-App import graph.
  server.tool(
    "claws_issue_phases",
    "For an issue with a multi-PR implementation plan, list its plan steps and which are already covered by an open/merged PR or a `claws-phase-done:` claim comment. Check this before implementing a step by hand, and mark any step you complete so Claws does not redo it.",
    {
      repo: z.string().describe("Repository full name (e.g. 'owner/repo')"),
      issue: z.number().describe("Issue number"),
    },
    async ({ repo, issue }) => {
      try {
        const query = `?repo=${encodeURIComponent(repo)}&issue=${encodeURIComponent(String(issue))}`;
        return textResult(await deps.fetchApi(`/api/issue-phases${query}`, 5000));
      } catch (err) {
        return errorResult(`Phase lookup failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  );

  // Tool: claws_wait_for_change
  // Long-polls /api/events. The fetch timeout is deliberately longer than the
  // server's own clamp so the server always wins and the client never aborts a
  // healthy wait.
  server.tool(
    "claws_wait_for_change",
    "Block until Claws performs a GitHub state change you care about — a comment or plan posted, a label added/removed, a PR opened/merged/closed, an issue closed, or an agent task starting/finishing/failing. Returns as soon as a matching change happens, so use this instead of sleeping and re-polling `gh`. Only changes made by Claws itself are reported; a human action on GitHub is not. Call once with timeout_seconds=0 to get the current cursor BEFORE you change GitHub state, then pass that lastId back as `after`. If `restarted` is true the Claws service restarted, your cursor is void, and you must re-check state with `gh` before waiting again.",
    {
      repo: z.string().optional().describe("Repository full name, e.g. 'owner/repo'. Omit to watch all repos."),
      items: z.array(z.number()).optional().describe("Issue/PR numbers to watch. An event also matches when one of these numbers is referenced in the item's title or body, so waiting on an issue number also catches the PR opened for it."),
      kinds: z.array(z.string()).optional().describe("Restrict to these event kinds. Omit for all."),
      after: z.number().optional().describe("Cursor: only report events with id greater than this. Omit to watch only events from now on."),
      timeout_seconds: z.number().optional().describe("How long to block, 0-270. Default 240. Use 0 for a non-blocking read of the current cursor."),
    },
    async ({ repo, items, kinds, after, timeout_seconds }) => {
      const timeout = Math.min(270, Math.max(0, Math.trunc(timeout_seconds ?? 240)));
      const params: string[] = [`timeout=${timeout}`];
      if (repo) params.push(`repo=${encodeURIComponent(repo)}`);
      if (items?.length) params.push(`items=${encodeURIComponent(items.join(","))}`);
      if (kinds?.length) params.push(`kinds=${encodeURIComponent(kinds.join(","))}`);
      if (after !== undefined) params.push(`after=${encodeURIComponent(String(after))}`);
      try {
        return textResult(await deps.fetchApi(`/api/events?${params.join("&")}`, (timeout + 15) * 1000));
      } catch (err) {
        return errorResult(`Event wait failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  );

  // Tool: claws_config
  server.tool(
    "claws_config",
    "Get the operator's skip and priority lists from Claws configuration",
    {},
    async () => {
      try {
        const { skippedItems, prioritizedItems } = await deps.configSnapshot();
        return textResult({ skippedItems, prioritizedItems });
      } catch (err) {
        return errorResult(`Config read failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  );

  // Tool: claws_set_session_title — only in an interactive session, and only
  // ever retitles the session this server was built for.
  const sessionId = deps.sessionId;
  if (sessionId) {
    server.tool(
      "claws_set_session_title",
      "Set the description shown for THIS interactive session on the Claws dashboard's sessions list. Use it when the user asks to name, title, or re-label the session, or invokes /title. Setting a title pins it: Claws stops auto-summarising this session until the title is cleared. Pass an empty string to clear the pin and resume automatic summaries. Titles are trimmed to 120 characters. Cannot affect any other session.",
      {
        title: z.string().describe("Short description, <=120 chars. Empty string clears the manual title and resumes auto-summarisation."),
      },
      async ({ title }) => {
        try {
          const res = await deps.fetchApi(
            `/api/sessions/${encodeURIComponent(sessionId)}/description`,
            5000,
            { method: "POST", body: { description: title } },
          ) as { description?: string | null };
          return textResult(
            res.description
              ? { ok: true, title: res.description }
              : { ok: true, title: null, note: "Manual title cleared; automatic summaries resume." },
          );
        } catch (err) {
          return errorResult(`Set title failed: ${err instanceof Error ? err.message : err}`);
        }
      },
    );

    // Tool: claws_set_session_status — self-reported state for the dashboard's
    // Active sessions list (#3083). Mirrors SESSION_AGENT_STATUSES in sessions.ts,
    // which this leaf module cannot import.
    server.tool(
      "claws_set_session_status",
      "Report THIS interactive session's current state to the Claws dashboard's Active sessions list. working = actively executing a task in this thread; monitoring = waiting on background agents, a scheduled wake-up, CI, a PR or a deployment you are watching; waiting = stopped and needs the user's input or decision; done = the user's request is complete. Call it whenever the state changes. Cannot affect any other session.",
      {
        status: z.enum(["working", "monitoring", "waiting", "done"]).describe("The session's current state"),
      },
      async ({ status }) => {
        try {
          await deps.fetchApi(
            `/api/sessions/${encodeURIComponent(sessionId)}/status`,
            5000,
            { method: "POST", body: { status } },
          );
          return textResult({ ok: true, status });
        } catch (err) {
          return errorResult(`Set status failed: ${err instanceof Error ? err.message : err}`);
        }
      },
    );

    // Tool: claws_request_capability (#3072) — ask the operator for a
    // capability mid-session. Posts the request, then polls its status until
    // the operator decides or the wait ends. The API never returns a credential
    // value, only where the grant's vars were written.
    server.tool(
      "claws_request_capability",
      "Request a capability this session was not granted at start (one listed under 'Requestable capabilities' in your instructions), e.g. kubectl access to a cluster. A human must approve the request on this session's Claws page; this call waits up to timeout_seconds for the decision. No secret value is ever returned: on approval you get the capability's usage guidance and how to load its credentials. Give a short reason saying why the current task needs it. Cannot affect any other session.",
      {
        capability: z.string().describe("Capability id, e.g. 'prod-infra'"),
        reason: z.string().describe("Why the current task needs it, <=300 chars; shown to the user"),
        timeout_seconds: z.number().optional().describe("How long to wait for the decision, 0-270. Default 240. Use 0 to check without waiting."),
      },
      async ({ capability, reason, timeout_seconds }) => {
        const timeout = Math.min(270, Math.max(0, Math.trunc(timeout_seconds ?? 240)));
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        const base = `/api/sessions/${encodeURIComponent(sessionId)}/capability-requests`;
        try {
          let state = await deps.fetchApi(base, 10_000, { method: "POST", body: { capability, reason } }) as CapabilityRequestState;
          const deadline = Date.now() + timeout * 1000;
          while (state.status === "pending" && Date.now() < deadline) {
            await sleep(Math.min(CAPABILITY_POLL_MS, deadline - Date.now()));
            state = await deps.fetchApi(`${base}/${encodeURIComponent(capability)}`, 10_000) as CapabilityRequestState;
          }
          return textResult(capabilityRequestResult(capability, state));
        } catch (err) {
          return errorResult(`Capability request failed: ${err instanceof Error ? err.message : err}`);
        }
      },
    );
  }
}

const CAPABILITY_POLL_MS = 3000;

/** The subset of the capability-request API response the tool reads. */
interface CapabilityRequestState {
  status: "pending" | "granted" | "denied";
  description?: string;
  loadPath?: string | null;
  live?: boolean | null;
  marker?: string | null;
  delayed?: boolean;
}

function capabilityRequestResult(capability: string, state: CapabilityRequestState): Record<string, unknown> {
  if (state.status === "denied") {
    return { status: "denied", capability, note: "The user denied this request. Do not request it again unless the user asks." };
  }
  if (state.status !== "granted") {
    return {
      status: "pending",
      capability,
      note: "Not decided yet. Tell the user to approve it on this session's Claws page, then call claws_request_capability again to keep waiting.",
    };
  }
  let load: string;
  if (state.live === false) {
    load = "Granted; effective after the user resumes the session.";
  } else if (state.loadPath) {
    load = `Each Bash call is a fresh shell — prefix commands that need it with \`. ${state.loadPath} && \`.`;
    if (state.delayed) {
      const check = state.marker ? ` (\`grep -qxF '${state.marker}' ${state.loadPath}\` succeeds once it has)` : "";
      load += ` The file can take up to 2 minutes to update${check}; if it lacks the variables, wait and retry.`;
    }
  } else {
    load = "Its credentials, if any, are already in your environment; nothing to load.";
  }
  return { status: "granted", capability, usage: state.description ?? "", load };
}
