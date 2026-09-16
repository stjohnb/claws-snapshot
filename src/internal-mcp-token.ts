/** Shared location of the Claws internal MCP bearer token.
 *  Pure — imports only node:fs/node:path, so mcp-server.ts (a standalone stdio
 *  child that must not import config.ts) can read it too. */
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
  try {
    const t = fs.readFileSync(internalMcpTokenPath(workDir), "utf-8").trim();
    return t.length > 0 ? t : fallback;
  } catch {
    return fallback;
  }
}
