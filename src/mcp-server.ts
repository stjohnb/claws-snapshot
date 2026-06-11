#!/usr/bin/env node

/**
 * Claws MCP Server — exposes Claws operational state to Claude sessions.
 *
 * Runs as a stdio-based MCP server spawned by Claude CLI via --mcp-config.
 * Provides four core tools: claws_status, claws_task_history, claws_open_prs, claws_config,
 * plus optionally namey_query when NAMEY_DB_URL is configured, and ha_list_entities /
 * ha_api_request when HOME_ASSISTANT_BASE_URL + HOME_ASSISTANT_TOKEN are configured.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type pg from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { handleNameyQuery, QUERY_TIMEOUT_MS } from "./namey-query.js";
import { handleListEntities, handleApiRequest } from "./ha-mcp.js";

const PrListSchema = z.array(z.object({
  number: z.number(),
  title: z.string(),
  headRefName: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  author: z.object({ login: z.string() }),
  updatedAt: z.string(),
  isDraft: z.boolean(),
}));

const ConfigSnapshotSchema = z.object({
  skippedItems: z.array(z.unknown()).optional(),
  prioritizedItems: z.array(z.unknown()).optional(),
}).passthrough();

const WORK_DIR = process.env["CLAWS_MCP_WORK_DIR"] ?? "";
const PORT = process.env["CLAWS_MCP_PORT"] ?? "3000";
const AUTH_TOKEN = process.env["CLAWS_MCP_AUTH_TOKEN"] ?? "";
const NAMEY_DB_URL = process.env["NAMEY_DB_URL"] ?? "";
const HA_BASE_URL = process.env["HOME_ASSISTANT_BASE_URL"] ?? "";
const HA_TOKEN = process.env["HOME_ASSISTANT_TOKEN"] ?? "";

function openDb(): Database.Database | null {
  const dbPath = path.join(WORK_DIR, "claws.db");
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

async function fetchState(): Promise<unknown> {
  const url = `http://localhost:${PORT}/api/state`;
  const headers: Record<string, string> = {};
  if (AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function execGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// ── MCP Server ──

const server = new McpServer({
  name: "claws-state",
  version: "1.0.0",
});

// Tool: claws_status
server.tool(
  "claws_status",
  // Claude queue entries come from fetchState() which hits /api/state (includes claudeQueueEntries).
  "Get current Claws operational status: running tasks, queue items by category, Claude queue pending/active counts, and Claude queue entries with position and metadata",
  {},
  async () => {
    const parts: Record<string, unknown> = {};

    // HTTP state (queue + claude queue)
    try {
      parts.queue = await fetchState();
    } catch (err) {
      parts.queueError = `Queue data unavailable: ${err instanceof Error ? err.message : err}`;
    }

    // SQLite running tasks
    const db = openDb();
    if (db) {
      try {
        const rows = db.prepare(
          `SELECT job_name, repo, item_number, started_at FROM tasks WHERE status = 'running' ORDER BY started_at ASC`,
        ).all();
        parts.runningTasks = rows;
      } catch (err) {
        parts.runningTasksError = `DB query failed: ${err instanceof Error ? err.message : err}`;
      } finally {
        db.close();
      }
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(parts, null, 2) }] };
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
    const db = openDb();
    if (!db) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Database not available" }) }] };
    }

    try {
      let rows;
      if (item_number !== undefined) {
        rows = db.prepare(`
          SELECT t.job_name, t.item_number, t.status, t.error, t.started_at, t.completed_at,
                 jr.job_name AS run_job
          FROM tasks t
          LEFT JOIN job_runs jr ON t.run_id = jr.run_id
          WHERE t.repo = ? AND t.item_number = ?
          ORDER BY t.started_at DESC LIMIT 20
        `).all(repo, item_number);
      } else {
        rows = db.prepare(`
          SELECT t.job_name, t.item_number, t.status, t.error, t.started_at, t.completed_at,
                 jr.job_name AS run_job
          FROM tasks t
          LEFT JOIN job_runs jr ON t.run_id = jr.run_id
          WHERE t.repo = ?
          ORDER BY t.started_at DESC LIMIT 20
        `).all(repo);
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: `DB query failed: ${err instanceof Error ? err.message : err}` }) }] };
    } finally {
      db.close();
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
      const output = await execGh([
        "pr", "list", "--repo", repo, "--json",
        "number,title,headRefName,labels,author,updatedAt,isDraft",
      ]);
      const prs = PrListSchema.parse(JSON.parse(output));
      return { content: [{ type: "text" as const, text: JSON.stringify(prs, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: `gh CLI failed: ${err instanceof Error ? err.message : err}` }) }] };
    }
  },
);

// Tool: claws_config
server.tool(
  "claws_config",
  "Get the operator's skip and priority lists from Claws configuration",
  {},
  async () => {
    const configPath = path.join(WORK_DIR, "config.json");
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const config = ConfigSnapshotSchema.parse(JSON.parse(raw));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            skippedItems: config.skippedItems ?? [],
            prioritizedItems: config.prioritizedItems ?? [],
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Config read failed: ${err instanceof Error ? err.message : err}` }) }] };
    }
  },
);

// ── Namey PostgreSQL pool (lazy, promise-cached to prevent race conditions) ──

let nameyPoolPromise: Promise<pg.Pool> | null = null;

function getNameyPool(): Promise<pg.Pool> {
  if (!nameyPoolPromise) {
    nameyPoolPromise = (async () => {
      const { default: pgModule } = await import("pg");
      const pool = new pgModule.Pool({
        connectionString: NAMEY_DB_URL,
        // rejectUnauthorized: false — DB is on a private network behind a firewall
        ssl: { rejectUnauthorized: false },
        max: 2,
        connectionTimeoutMillis: 10_000,
        statement_timeout: QUERY_TIMEOUT_MS,
      });
      // Idle client errors (network blip, DB restart) — pool removes dead clients automatically.
      // Without this handler, Node's EventEmitter would treat them as uncaught exceptions.
      pool.on("error", (err) => {
        process.stderr.write(`[namey-pool] idle client error: ${err.message}\n`);
      });
      return pool;
    })();
    // Reset on failure so the next call retries instead of returning the cached rejection.
    nameyPoolPromise.catch(() => { nameyPoolPromise = null; });
  }
  return nameyPoolPromise;
}

// Tool: namey_query — only registered when NAMEY_DB_URL is configured
if (NAMEY_DB_URL) {
  server.tool(
    "namey_query",
    "Run a read-only SQL query against the namey production PostgreSQL database. Use this to generate statistics, check data, or investigate issues. The database contains baby names, user data, popularity stats, shortlists, and more. Returns JSON rows.",
    {
      sql: z.string().describe("SQL query to execute (read-only, max 30s timeout, results capped at 500 rows)"),
    },
    async ({ sql }) => {
      let pool: pg.Pool;
      try {
        pool = await getNameyPool();
      } catch (err) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Pool init failed: ${(err as Error).message}` }) }] };
      }
      return handleNameyQuery(sql, pool);
    },
  );
}

// Tool: ha_list_entities + ha_api_request — only registered when HA is configured
if (HA_BASE_URL && HA_TOKEN) {
  server.tool(
    "ha_list_entities",
    "List Home Assistant entity IDs with current state and friendly name. Use this to discover entities when writing automations/scripts. Optionally filter by domain (e.g. 'light', 'sensor') or a search substring. Returns a projected, capped list — for full attributes of one entity use ha_api_request with /api/states/{entity_id}.",
    {
      domain: z.string().optional().describe("Entity domain prefix, e.g. 'light'"),
      search: z.string().optional().describe("Case-insensitive substring matched against entity_id and friendly name"),
    },
    async ({ domain, search }) => handleListEntities(HA_BASE_URL, HA_TOKEN, { domain, search }),
  );
  server.tool(
    "ha_api_request",
    "Make an arbitrary request to the Home Assistant REST API and return the response. Gives full access to HA. path must be a relative path beginning with /api/. Common GET paths: /api/states/{entity_id}, /api/services, /api/config, /api/error_log, /api/history/period/{ISO8601}?filter_entity_id=..., /api/logbook/{ISO8601}. POST examples: /api/template with body {\"template\":\"{{ states('sun.sun') }}\"}; /api/services/{domain}/{service} with body of service data to invoke a service. Responses are truncated at 50k chars.",
    {
      method: z.enum(["GET", "POST"]).optional().describe("HTTP method, default GET"),
      path: z.string().describe("Relative HA API path beginning with /api/"),
      body: z.record(z.string(), z.unknown()).optional().describe("JSON body for POST requests"),
    },
    async ({ method, path: apiPath, body }) => handleApiRequest(HA_BASE_URL, HA_TOKEN, { method, path: apiPath, body }),
  );
}

// ── Start ──

process.on("beforeExit", async () => {
  if (nameyPoolPromise) {
    const promise = nameyPoolPromise;
    nameyPoolPromise = null;
    const pool = await promise;
    await pool.end().catch(() => {});
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
