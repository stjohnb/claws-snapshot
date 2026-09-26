/** Shared location of the Claws internal MCP bearer token.
 *  Pure — imports only node builtins, so mcp-server.ts (a standalone stdio
 *  child that must not import config.ts) can read it too. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const INTERNAL_MCP_TOKEN_FILE = "internal-mcp-token";

export function internalMcpTokenPath(workDir: string): string {
  return path.join(workDir, INTERNAL_MCP_TOKEN_FILE);
}

/** Publish this boot's token. Overwritten every startup; 0600. */
export function writeInternalMcpTokenFile(workDir: string, token: string): void {
  const p = internalMcpTokenPath(workDir);
  fs.writeFileSync(p, token, { mode: 0o600 });
  // load-bearing: `mode` is masked by umask and ignored when the file already exists
  fs.chmodSync(p, 0o600);
}

/** Read the live token, falling back to the value baked into the MCP config at
 *  session-spawn time when the file is missing, empty or unreadable (#2918). */
export function readInternalMcpToken(workDir: string, fallback: string): string {
  if (!workDir) return fallback;
  return readMcpTokenFile(internalMcpTokenPath(workDir), fallback);
}

/** The token in `file`, or `fallback` when it is missing, empty or unreadable. */
export function readMcpTokenFile(file: string, fallback: string): string {
  try {
    const t = fs.readFileSync(file, "utf-8").trim();
    return t.length > 0 ? t : fallback;
  } catch {
    return fallback;
  }
}

/** SHA-256 (hex) of an agent pod's MCP token — what `work_queue.agent_mcp_token_sha256` stores. */
export function hashAgentMcpToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
