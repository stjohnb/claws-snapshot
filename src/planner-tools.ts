/**
 * The planner MCP tools — how a planner run hands Claws its plan, outcome,
 * follow-up verdict or alert triage.
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
 * child process, so this module imports only the SDK type, `zod`,
 * `mcp-result.js` and the leaf `requirements-record.js`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResult, errorResult, type ToolResult } from "./mcp-result.js";
import { RequirementsRecordSchema } from "./requirements-record.js";

export type PlannerToolStage = "plan" | "refine" | "step_back" | "followup" | "verify";

export interface PlannerToolDeps {
  /** The planner run these tools act for; empty registers nothing. */
  runId: string;
  stage: PlannerToolStage;
  /**
   * Which optional outcomes the prompt offered (`CLAWS_MCP_PLANNER_OFFERS`).
   * `alertTriage` marks an alert inbox run: it registers
   * `claws_save_alert_triage` and marks the plan and outcome tools as not for
   * this issue.
   */
  offers: { duplicates: boolean; transfer: boolean; alertTriage?: boolean };
  /** False for a plan-only run (`allowOutcomes: false`) — omits `claws_report_outcome`
   *  entirely rather than registering a tool the server rejects every call to
   *  (`CLAWS_MCP_PLANNER_ALLOW_OUTCOMES`). Defaults to true. */
  outcomes?: boolean;
  /** Call a Claws API route; resolves to the parsed JSON body or throws `HTTP <status>: <error>`. */
  fetchApi(pathAndQuery: string, timeoutMs: number, init?: { method: string; body: unknown }): Promise<unknown>;
}

/** Parse `CLAWS_MCP_PLANNER_OFFERS` (`"duplicate,transfer,alert-triage"`) into flags. */
export function parsePlannerOffers(raw: string): { duplicates: boolean; transfer: boolean; alertTriage: boolean } {
  const parts = new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  return { duplicates: parts.has("duplicate"), transfer: parts.has("transfer"), alertTriage: parts.has("alert-triage") };
}

/** Prefix on the plan and outcome tools in an alert inbox run. */
const NOT_FOR_ALERT_INBOX = "NOT FOR THIS ISSUE — it is an alert inbox: triage it with claws_save_alert_triage instead. ";

export function isPlannerToolStage(value: string): value is PlannerToolStage {
  return value === "plan" || value === "refine" || value === "step_back" || value === "followup" || value === "verify";
}

function planShape(withResponse: boolean) {
  return {
    plan: z.string().describe("The complete plan in markdown, starting with its first section. Keep the `### PR N:` headers when the plan needs several PRs. Do NOT put the model recommendations, CLAWS_TARGET_PR or a reply to feedback in this text — they have their own fields."),
    prs: z.array(z.object({
      repo: z.string().describe("owner/name of the repository this PR is opened in"),
      title: z.string().describe("Short PR title, matching its `### PR N:` header (<=200 chars)"),
      depends_on: z.array(z.number().int().positive()).optional().describe("Positions within this plan this PR must land after; omit for 'after the previous PR', `[]` for independent"),
      manual_action_before_merge: z.string().optional().describe("The operator step that must be done before this PR merges (e.g. 'Import the repo on Forgejo and add the deploy key'), <=300 chars. Claws records it on the PR as a merge hold: the PR goes through CI-fix and review as normal, and once it is otherwise ready to merge Claws tells the issue the PR waits on the step, while the issue's other steps carry on; the PR is not merged — even under Automerge — until the operator clears that PR's hold. Omit when nothing manual precedes this PR."),
    })).describe("The PRs the plan needs, in merge order: one entry per `### PR N:` section, or exactly one entry for a single-PR plan. Do not list the plan's `### Manual actions (operator)` section: Claws tracks it as a final step with no PR."),
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

  if (deps.stage === "followup") {
    server.tool(
      "claws_save_plan",
      "Save the COMPLETE revised implementation plan — only when your verdict is \"plan_amendment\" or \"design_change\". An amendment must keep the plan's PR list exactly: same number of PRs, same repo at each position, same manual-actions section; a design change may change it. Claws edits the plan comment in place after you finish; nothing is published until then. Calling again replaces the earlier plan.",
      planShape(false),
      async (args) => submit(deps, "plan", args, "Plan saved. Now call claws_followup_verdict with verdict \"plan_amendment\" or \"design_change\"."),
    );
    server.tool(
      "claws_followup_verdict",
      "Report what your reply to the follow-up comments does. verdict \"answered\" (the default) — a question, clarification or concern answered with no plan change. verdict \"plan_amendment\" — the comments change details within the current PR set; call claws_save_plan with the complete amended plan FIRST, then this tool, listing in affected_prs the open step PRs that must change to match. verdict \"design_change\" — the comments add, remove, reorder or redirect PRs, or contradict the approved requirements; call claws_save_plan with the complete revised plan FIRST, then this tool with the complete revised requirements record and one pr_fates entry per open step PR. Claws stores both for the operator's re-approval and holds every PR you close or rework until then. Your final message is still the reply. Calling again replaces the earlier verdict.",
      {
        verdict: z.enum(["answered", "plan_amendment", "design_change"]),
        affected_prs: z.array(z.object({
          repo: z.string().describe("owner/name of the open PR's repository"),
          number: z.number().int().positive().describe("The open PR's number"),
        })).optional().describe("plan_amendment only: the open step PRs that must change to match the amended plan; omit or [] when none must"),
        requirements: RequirementsRecordSchema.optional().describe("design_change only: the COMPLETE revised requirements record — every field, not a diff"),
        pr_fates: z.array(z.object({
          repo: z.string().describe("owner/name of the PR's repository"),
          number: z.number().int().positive().describe("The PR's number"),
          fate: z.enum(["close", "rework", "keep"]).describe("close — superseded, closed on approval; rework — its branch takes the revised plan's step at position; keep — it already covers the step at position"),
          position: z.number().int().positive().optional().describe("rework and keep: the revised plan's step (1-based PR position) the PR covers, in the PR's own repo"),
        })).optional().describe("design_change only: exactly one entry per open step PR; a merged PR may also be listed with keep to count it as covering a step"),
      },
      async (args) => submit(deps, "followup", args, "Verdict recorded. Finish with your reply as the final message; calling again replaces the verdict."),
    );
    return;
  }

  if (deps.stage === "verify") {
    server.tool(
      "claws_keep_plan",
      "Keep the existing plan UNCHANGED: it still fits the current state of the repositories, the merged PRs and the issue's comments. Claws leaves the plan text and its version as they are and returns the issue to plan review. `reason` (<=400 chars) says why it still fits; it is posted on the issue. Call either this or claws_save_plan; the later call wins.",
      { reason: z.string().describe("One or two sentences on why the plan still fits, <=400 chars") },
      async (args) => submit(deps, "keep-plan", args, "Plan kept. Finish now; calling claws_save_plan instead replaces this verdict."),
    );
    server.tool(
      "claws_save_plan",
      "Save the COMPLETE revised implementation plan — only when the existing plan no longer fits the current state. Keep shipped steps at their positions. Claws edits the plan comment in place after you finish, the earlier version moving under Previous plans. Call either this or claws_keep_plan; the later call wins.",
      planShape(false),
      async (args) => submit(deps, "plan", args, "Revised plan saved. Claws publishes it when this run finishes; calling claws_keep_plan instead replaces it."),
    );
    return;
  }

  const allowOutcomes = deps.outcomes ?? true;
  const alertTriage = deps.offers.alertTriage ?? false;
  const notForInbox = alertTriage ? NOT_FOR_ALERT_INBOX : "";

  if (alertTriage) {
    server.tool(
      "claws_save_alert_triage",
      "Save this alert inbox's triage: one verdict per alert section you were asked to triage. verdict \"transient\" — the alert needs no work; `reason` is one sentence (<=300 chars). verdict \"tracked\" — the alert needs work: file its dedicated issue with claws_create_issue FIRST (the section's exact dedupeKey), then pass the returned clw_… id as `issue_id` (a deduplicated reply's id counts). Claws links, annotates and parks the inbox after you finish; nothing is published until then. Call it once; calling again replaces the earlier triage.",
      {
        verdicts: z.array(z.object({
          alertname: z.string().describe("The section's alertname, exactly as its `### ` heading"),
          verdict: z.enum(["transient", "tracked"]),
          reason: z.string().optional().describe("transient only, required: one sentence on why no work is needed, <=300 chars"),
          issue_id: z.string().optional().describe("tracked only, required: the clw_… id of the dedicated issue"),
        })).describe("One entry per alert section triaged"),
      },
      async (args) => submit(deps, "alert-triage", args, "Triage saved. Claws applies it when this run finishes; calling again replaces it."),
    );
  }

  server.tool(
    "claws_save_plan",
    `${notForInbox}Save the implementation plan for this issue. Call it exactly once when the plan is final (calling again replaces the earlier plan). Claws posts the plan after you finish — nothing is published until then.${allowOutcomes ? " Call either this or claws_report_outcome, never both." : ""}`,
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
    `no_code_changes — needs no change to any file tracked in this repository; also set no_change_kind: already_resolved (the fix merged or the build is green again), transient (a runner was evicted or a node was off mid-job; nothing to do) or operator_task (a human must set a secret, sign an agreement or check a cluster job)`,
  ];
  server.tool(
    "claws_report_outcome",
    `${notForInbox}Report that this issue should NOT get an implementation plan. Outcomes: ${outcomeDocs.join("; ")}. explanation is a short paragraph (2-4 sentences) saying why; it is posted on the issue. Call either this or claws_save_plan, never both.`,
    {
      outcome: z.enum(outcomes),
      ...(deps.offers.duplicates ? { duplicate_of: z.union([z.number(), z.string()]).optional().describe("The candidate issue this duplicates") } : {}),
      ...(deps.offers.transfer ? { transfer_to: z.string().optional().describe("owner/name, copied exactly from Repository Routing") } : {}),
      no_change_kind: z.enum(["already_resolved", "transient", "operator_task"]).optional().describe("no_code_changes only, required: already_resolved, transient or operator_task"),
      explanation: z.string().describe("2-4 sentences explaining the outcome"),
    },
    async (args) => submit(deps, "outcome", args, "Outcome recorded. Finish now; calling again replaces it."),
  );
}
