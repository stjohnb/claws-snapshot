/**
 * Pure renderers for the files a session pod (and an agent pod) is launched
 * with (#2138): the sourced env file for granted capability credentials, the
 * granted env file a live grant updates (#3072), the session prompt file, and
 * the per-provider config bodies for Codex, OpenCode and pi. The pod launchers
 * ship these bodies in a Secret; nothing here touches the filesystem.
 */

/** Single-quote a value for POSIX `sh` sourcing. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render `vars` as the sourced env-file body: one `export KEY='value'` line
 * per var, single-quoted for POSIX `sh`. Shared by the session and agent pod
 * launchers, which ship the body in a Secret.
 */
export function renderSessionEnvFile(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `export ${k}=${shellQuote(v)}\n`)
    .join("");
}

/** The exact bytes the pod's `POD_SYSTEM_PROMPT_PATH` file holds: `text` with a guaranteed trailing newline. */
export function sessionPromptFileContent(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * The comment line a granted env file carries for each capability whose vars it
 * holds (#3072). A reader of a file that updates eventually (a pod's mounted
 * Secret) checks for it before sourcing: `grep -qxF '<marker>' <file>`.
 */
export function grantedEnvMarker(capId: string): string {
  return `# claws-granted: ${capId}`;
}

/** A granted env file body: one `grantedEnvMarker` line per id, sorted, then the exports. */
export function renderGrantedEnvFile(ids: string[], vars: Record<string, string>): string {
  return [...ids].sort().map((id) => `${grantedEnvMarker(id)}\n`).join("") + renderSessionEnvFile(vars);
}

function tomlBasicString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The image's npm prefix is root-owned, so Codex's self-update
 * (`npm install -g @openai/codex`) always fails with EACCES when a session
 * runs as uid 1000, and the interactive update prompt crashed sessions
 * (#3312). New Codex versions ship through the image instead.
 */
export const CODEX_DISABLE_UPDATE_CHECK_TOML = "check_for_update_on_startup = false";

/** Codex remote MCP server config for a session's claws-state endpoint: the token value stays in the env file. */
export function codexRemoteMcpServersToml(name: string, url: string, bearerTokenEnvVar: string): string {
  return [
    `[mcp_servers.${name}]`,
    `url = ${tomlBasicString(url)}`,
    `bearer_token_env_var = ${tomlBasicString(bearerTokenEnvVar)}`,
  ].join("\n");
}

/** Session-local Codex `config.toml`: no inherited plugins, plus prompt and optional session MCP servers. */
export function codexConfigBody(developerInstructions?: string, mcpServersToml = ""): string {
  const comment = "# Claws session-local Codex config. Ambient plugins and MCP servers are intentionally not inherited.\n";
  const instructions = developerInstructions?.trim();
  const body = `${comment}${CODEX_DISABLE_UPDATE_CHECK_TOML}\n${instructions ? `developer_instructions = ${tomlBasicString(instructions)}\n` : ""}`;
  return mcpServersToml.trim() ? `${body}\n${mcpServersToml.trim()}\n` : body;
}

export interface OpencodeRemoteMcpServer {
  type: "remote";
  url: string;
  headers: Record<string, string>;
}

/**
 * OpenCode config JSON with session instructions and optional provider-specific
 * MCP entries. OpenCode has no `--append-system-prompt`; `--prompt` would
 * submit the text as the first *user* message, which made sessions launch
 * straight into work instead of waiting for the human (#2866). Config
 * `instructions` are folded into the system prompt instead, and — unlike
 * `--prompt` — survive a `--continue` resume.
 */
export function opencodeConfigBody(instructionsPath: string, mcp: Record<string, OpencodeRemoteMcpServer> = {}): string {
  return `${JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    instructions: [instructionsPath],
    ...(Object.keys(mcp).length > 0 ? { mcp } : {}),
  }, null, 2)}\n`;
}

/**
 * pi `mcp.json` for a session's remote claws-state MCP server. pi expands
 * `${VAR}` in headers, so the bearer token value stays in the env file.
 */
export function piRemoteMcpJson(name: string, url: string, bearerEnvVar: string): string {
  return JSON.stringify({
    mcpServers: {
      [name]: {
        url,
        headers: { Authorization: `Bearer \${${bearerEnvVar}}` },
        // Seconds. Both claws-state long-poll tools allow 270 seconds; leave HTTP overhead.
        timeout: 300,
      },
    },
  });
}
