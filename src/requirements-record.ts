/**
 * The requirements record — what an issue asks for, written by the
 * requirements writer before anyone plans it (docs/refinements/issue-flow.md
 * "The requirements record").
 *
 * A leaf: `requirements-tools.ts` runs inside the standalone `mcp-server.ts`
 * child process, and `db.ts` imports the type, so this module imports only
 * `zod`.
 */

import { z } from "zod";

/** The header of the Claws comment a record is rendered into. */
export const REQUIREMENTS_HEADER = "## Requirements";

export const REQUIREMENTS_TITLE_MAX = 120;

export const RequirementsRecordSchema = z.object({
  title: z.string().trim().min(1).max(REQUIREMENTS_TITLE_MAX)
    .describe(`A short, specific issue title (<=${REQUIREMENTS_TITLE_MAX} chars) naming the outcome, not the implementation`),
  kind: z.enum(["bug", "feature"]).describe("bug — something that should already work does not; feature — new or changed behaviour"),
  context: z.string().trim().min(1).describe("Why this matters: who is affected, the current behaviour and the evidence, in a short paragraph"),
  requirement: z.string().trim().min(1).describe("What must be true when this issue is done, stated as observable behaviour — never how to build it"),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1)
    .describe("Checkable statements a reviewer can verify one by one; at least one"),
  outOfScope: z.array(z.string().trim().min(1))
    .describe("Things a reader might expect this issue to cover that it deliberately does not; [] when none"),
});

export type RequirementsRecord = z.infer<typeof RequirementsRecordSchema>;

function bullets(items: readonly string[]): string {
  return items.length === 0 ? "_None._" : items.map((item) => `- ${item}`).join("\n");
}

/** The record as the markdown body of a `## Requirements` comment, before attribution. */
export function renderRequirementsComment(record: RequirementsRecord): string {
  return [
    REQUIREMENTS_HEADER,
    ``,
    `**Title:** ${record.title}`,
    ``,
    `**Kind:** ${record.kind}`,
    ``,
    `### Context`,
    ``,
    record.context,
    ``,
    `### Requirement`,
    ``,
    record.requirement,
    ``,
    `### Acceptance criteria`,
    ``,
    bullets(record.acceptanceCriteria),
    ``,
    `### Out of scope`,
    ``,
    bullets(record.outOfScope),
  ].join("\n");
}

/**
 * Parse the JSON the `claws_save_requirements` tool wrote. Throws a readable
 * error when the text is not JSON or does not match the schema.
 */
export function parseRequirementsFile(json: string): RequirementsRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`requirements file is not JSON: ${err instanceof Error ? err.message : err}`);
  }
  const parsed = RequirementsRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`requirements file does not match the record schema: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
