/**
 * The requirements writer's MCP tool — how a writer run hands Claws its record.
 *
 * Registered on the stdio `claws-state` server (`mcp-server.ts`) only when
 * `CLAWS_MCP_REQUIREMENTS_OUT` is set, i.e. only in a config written for one
 * writer invocation (`writeAgentMcpConfig({ requirementsRun })`). The tool
 * validates the record and writes it as JSON to that file, which the writer
 * process reads once the CLI exits (`agents/requirements-writer.ts`). A file
 * rather than a service-side registry like `planner-runs.ts`: a writer in an
 * agent pod has no service-side run row to post to, but the pod shares its
 * filesystem with its own MCP child.
 *
 * A leaf, like `planner-tools.ts`: `mcp-server.ts` runs as a standalone child
 * process, so this module imports only the SDK type, `zod` (through the leaf
 * `requirements-record.ts`), `node:fs` and `mcp-result.js`.
 */

import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RequirementsRecordSchema } from "./requirements-record.js";
import { textResult, errorResult } from "./mcp-result.js";

export interface RequirementsToolDeps {
  /** Where the record is written; empty registers nothing. */
  outFile: string;
}

/** Register `claws_save_requirements`; a no-op without an out file. */
export function registerRequirementsTools(server: McpServer, deps: RequirementsToolDeps): void {
  if (!deps.outFile) return;
  server.tool(
    "claws_save_requirements",
    "Save the requirements record for this issue. Call it exactly once when the record is final (calling again replaces the earlier record). Claws posts the record after you finish — nothing is published until then.",
    RequirementsRecordSchema.shape,
    async (args) => {
      const parsed = RequirementsRecordSchema.safeParse(args);
      if (!parsed.success) {
        return { ...errorResult(`Rejected — fix the input and call again: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`), isError: true };
      }
      try {
        fs.writeFileSync(deps.outFile, JSON.stringify(parsed.data), { mode: 0o600 });
      } catch (err) {
        return { ...errorResult(`Could not save the record: ${err instanceof Error ? err.message : err}`), isError: true };
      }
      return textResult({ ok: true, note: "Requirements saved. Claws posts them when this run finishes; calling again replaces them." });
    },
  );
}
