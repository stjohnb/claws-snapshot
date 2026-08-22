/** Shared MCP tool-result helpers. Pure — no config/runtime dependencies. */

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

export function textResult(obj: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}
