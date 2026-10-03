/**
 * The planner MCP tools — how a planner run hands Claws its plan or outcome.
 *
 * Registered on the stdio `claws-state` server (`mcp-server.ts`) only when
 * `CLAWS_MCP_PLANNER_RUN_ID` is set, i.e. only in a config written for one
 * planner invocation (`writeAgentMcpConfig({ plannerRun })`). Session pods
 * (`claws-state-http.ts`) never register them. Every tool acts on that one run
 * id and nothing else; the service side validates each call
 * (`src/planner-runs.ts`) and a rejected call returns the error text, so the
 * agent can correct the input and call again.
 *
 * A leaf, like `claws-state-tools.ts`: `mcp-server.ts` runs as a standalone
 * child process, so this module imports only the SDK type, `zod` and
 * `mcp-result.js`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResult, errorResult, type ToolResult } from "./mcp-result.js";

export type PlannerToolStage = "plan" | "refine" | "step_back";

export interface PlannerToolDeps {
  /** The planner run these tools act for; empty registers nothing. */
  runId: string;
  stage: PlannerToolStage;
  /** Which optional outcomes the prompt offered (`CLAWS_MCP_PLANNER_OFFERS`). */
  offers: { duplicates: boolean; transfer: boolean };
  /** False for a plan-only run (`allowOutcomes: false`) — omits `claws_report_outcome`
   *  entirely rather than registering a tool the server rejects every call to
   *  (`CLAWS_MCP_PLANNER_ALLOW_OUTCOMES`). Defaults to true. */
  outcomes?: boolean;
  /** Call a Claws API route; resolves to the parsed JSON body or throws `HTTP <status>: <error>`. */
  fetchApi(pathAndQuery: string, timeoutMs: number, init?: { method: string; body: unknown }): Promise<unknown>;
}

/** Parse `CLAWS_MCP_PLANNER_OFFERS` (`"duplicate,transfer"`) into flags. */
export function parsePlannerOffers(raw: string): { duplicates: boolean; transfer: boolean } {
  const parts = new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  return { duplicates: parts.has("duplicate"), transfer: parts.has("transfer") };
}

export function isPlannerToolStage(value: string): value is PlannerToolStage {
  return value === "plan" || value === "refine" || value === "step_back";
}

function planShape(withResponse: boolean) {
  return {
    plan: z.string().describe("The complete plan in markdown, starting with its first section. Keep the `### PR N:` headers when the plan needs several PRs. Do NOT put the model recommendations, CLAWS_TARGET_PR or a reply to feedback in this text — they have their own fields."),
    prs: z.array(z.object({
      repo: z.string().describe("owner/name of the repository this PR is opened in"),
      title: z.string().describe("Short PR title, matching its `### PR N:` header (<=200 chars)"),
      depends_on: z.array(z.number().int().positive()).optional().describe("Positions within this plan this PR must land after; omit for 'after the previous PR', `[]` for independent"),
    })).describe("The PRs the plan needs, in merge order: one entry per `### PR N:` section, or exactly one entry for a single-PR plan."),
    implementation_model: z.enum(["haiku", "sonnet", "opus"]).describe("Model tier for the implementer"),
    review_model: z.enum(["sonnet", "opus"]).describe("Model tier for the PR reviewer"),
    target_pr: z.number().int().positive().optional().describe("Only when the work must land on an already-open PR's branch (single-PR plans only)"),
    ...(withResponse
      ? { response: z.string().optional().describe("Conversational reply to the feedback, posted as a separate comment. Omit when nobody left feedback.") }
      : {}),
  };
}

async function submit(deps: PlannerToolDeps, route: string, body: unknown, saved: string): Promise<ToolResult> {
  try {
    await deps.fetchApi(`/api/planner-runs/${encodeURIComponent(deps.runId)}/${route}`, 10_000, { method: "POST", body });
    return textResult({ ok: true, note: saved });
  } catch (err) {
    return { ...errorResult(`Rejected — fix the input and call again: ${err instanceof Error ? err.message : err}`), isError: true };
  }
}

/** Register the planner tools for `deps.stage`; a no-op without a run id. */
export function registerPlannerTools(server: McpServer, deps: PlannerToolDeps): void {
  if (!deps.runId) return;

  if (deps.stage === "step_back") {
    server.tool(
      "claws_step_back_verdict",
      "Report this step-back pass's verdict on the plan. verdict \"sound\" keeps the plan as it is. verdict \"reconsider\" needs a critique (<=400 words, addressed to a human reviewer) and, when you have one, the COMPLETE replacement plan in `revised` — the original is discarded, not merged. Call it once before finishing; calling again replaces the earlier verdict.",
      {
        verdict: z.enum(["sound", "reconsider"]),
        critique: z.string().optional().describe("What the original plan gets wrong and why the new approach is better"),
        revised: z.object(planShape(false)).optional().describe("The complete replacement plan, same fields as claws_save_plan"),
      },
      async (args) => submit(deps, "step-back", args, "Verdict recorded. Finish now; calling again replaces it."),
    );
    return;
  }

  const allowOutcomes = deps.outcomes ?? true;

  server.tool(
    "claws_save_plan",
    `Save the implementation plan for this issue. Call it exactly once when the plan is final (calling again replaces the earlier plan). Claws posts the plan after you finish — nothing is published until then.${allowOutcomes ? " Call either this or claws_report_outcome, never both." : ""}`,
    planShape(deps.stage === "refine"),
    async (args) => submit(deps, "plan", args, "Plan saved. Claws posts it when this run finishes; calling again replaces it."),
  );

  if (!allowOutcomes) return;

  const outcomes: [string, ...string[]] = [
    "blocked",
    "no_code_changes",
    ...(deps.offers.duplicates ? ["duplicate"] : []),
    ...(deps.offers.transfer ? ["transfer"] : []),
  ];
  const outcomeDocs = [
    ...(deps.offers.duplicates ? [`duplicate — shares a root cause with a candidate under "Possible Duplicate Candidates" (set duplicate_of)`] : []),
    ...(deps.offers.transfer ? [`transfer — unambiguously belongs to a repository under "Repository Routing" (set transfer_to)`] : []),
    `blocked — gated on a verifiable external precondition you checked today and confirmed is still unmet`,
    `no_code_changes — needs no change to any file tracked in this repository`,
  ];
  server.tool(
    "claws_report_outcome",
    `Report that this issue should NOT get an implementation plan. Outcomes: ${outcomeDocs.join("; ")}. explanation is a short paragraph (2-4 sentences) saying why; it is posted on the issue. Call either this or claws_save_plan, never both.`,
    {
      outcome: z.enum(outcomes),
      ...(deps.offers.duplicates ? { duplicate_of: z.union([z.number(), z.string()]).optional().describe("The candidate issue this duplicates") } : {}),
      ...(deps.offers.transfer ? { transfer_to: z.string().optional().describe("owner/name, copied exactly from Repository Routing") } : {}),
      explanation: z.string().describe("2-4 sentences explaining the outcome"),
    },
    async (args) => submit(deps, "outcome", args, "Outcome recorded. Finish now; calling again replaces it."),
  );
}
