/**
 * Planner runs — the in-process registry behind the planner MCP tools
 * (`claws_save_plan`, `claws_report_outcome`, `claws_step_back_verdict`).
 *
 * Each planner invocation opens a run with {@link withPlannerRun}: a random
 * UUID mapped to the issue, its stage and the allow-lists the prompt offered.
 * The UUID is baked into that invocation's MCP config, and it is the only
 * thing the tools can act on, so an agent cannot write to any other issue.
 * A tool call reaches {@link submitPlan} / {@link submitOutcome} /
 * {@link submitStepBack} through `POST /api/planner-runs/:id/...`; each
 * validates the input, returns an error the agent can fix and retry, and on
 * success records the submission on the run (the last call wins).
 *
 * Nothing is published from here. The refiner reads the submission with
 * {@link getSubmission} after the CLI exits, and only then posts the plan
 * comment and writes `claws_issue_prs` — so a timed-out or withheld run never
 * leaves a half-published plan. The registry is in memory on purpose, in
 * whichever process runs the refiner: a restart of that process kills the
 * worktree job holding the run anyway, and the tool call then gets a 404.
 *
 * Where the routes are served follows the registry. In the service
 * (`CLAWS_WORK_BACKEND=in-process`) `server.ts` mounts {@link plannerRunHandler}
 * under `/api/planner-runs`. In an agent pod the refiner runs inside the pod,
 * so the pod serves the same routes itself on a loopback listener
 * (`src/planner-run-listener.ts`) and the MCP child posts there
 * (`CLAWS_MCP_PLANNER_BASE_URL`); the service's copy of the routes never
 * knows a pod's run and would answer 404 (#clw_01M3A42ZTGECAB11S0BZA6NG1A).
 *
 * Every rejected call is counted on the run ({@link getRunRejections}) so the
 * refiner can tell "never called the tool" from "called it and was refused",
 * and refuse to publish the CLI's final message as a plan in the latter case.
 */

import crypto from "node:crypto";
import type { Context } from "hono";
import { parseIssueRef, sameIssueRef, type IssueRef } from "./issue-id.js";
import { parsePlan } from "./plan-parser.js";

export const PLAN_HEADER = "## Implementation Plan";

export function stripLeadingPlanHeader(output: string): string {
  const trimmed = output.trim();
  if (!trimmed.startsWith(PLAN_HEADER)) return trimmed;
  const rest = trimmed.slice(PLAN_HEADER.length);
  // Only strip a standalone header line — "## Implementation Plan for X" must survive.
  if (rest !== "" && !rest.startsWith("\n")) return trimmed;
  return rest.trim();
}

export type PlannerStage = "plan" | "refine" | "step_back";

export const MAX_PLANNED_PRS = 20;
export const MAX_PLANNED_PR_TITLE_CHARS = 200;

const IMPLEMENTATION_MODELS = ["haiku", "sonnet", "opus"] as const;
const REVIEW_MODELS = ["sonnet", "opus"] as const;
export type ImplementationModel = typeof IMPLEMENTATION_MODELS[number];
export type ReviewModel = typeof REVIEW_MODELS[number];

export interface PlannedPR {
  repo: string;
  title: string;
  /** Earlier positions this PR must land after; `[]` is independent, null unspecified (after the previous PR). */
  dependsOn: number[] | null;
}

export interface PlanSubmission {
  kind: "plan";
  /** Plan text with any leading `## Implementation Plan` header stripped. */
  plan: string;
  prs: PlannedPR[];
  implementationModel: ImplementationModel;
  reviewModel: ReviewModel;
  targetPr: number | null;
  /** Reply to the feedback — refine stage only. */
  response: string | null;
}

export type PlannerOutcome =
  | { kind: "duplicate"; duplicateOf: IssueRef }
  | { kind: "transfer"; transferTo: string }
  | { kind: "blocked" }
  | { kind: "no_code_changes" };

export interface OutcomeSubmission {
  kind: "outcome";
  outcome: PlannerOutcome;
  explanation: string;
}

export interface StepBackSubmission {
  kind: "step_back";
  verdict: "sound" | "reconsider";
  critique: string | null;
  revised: PlanSubmission | null;
}

export type PlannerSubmission = PlanSubmission | OutcomeSubmission | StepBackSubmission;

export interface PlannerRunInput {
  repo: string;
  issueRef: IssueRef;
  stage: PlannerStage;
  /** Repos a `prs[].repo` may name, canonical spelling. */
  allowedRepos: readonly string[];
  /** Issues offered as duplicate candidates; empty means the outcome is not offered. */
  allowedDuplicates?: readonly IssueRef[];
  /** Repos offered as transfer destinations; empty means the outcome is not offered. */
  allowedTransfers?: readonly string[];
  /** False for a pass that may only save a plan (a refinement); default true. */
  allowOutcomes?: boolean;
}

interface PlannerRun extends Required<PlannerRunInput> {
  submission: PlannerSubmission | null;
  /** Tool calls this run refused (validation failures); the "no such run" path has no run to count on. */
  rejectedCalls: number;
  lastRejection: string | null;
}

export type SubmitResult = { ok: true } | { ok: false; error: string };

/** Distinguishes "no such run" (404) from a validation failure (400). */
export const NO_SUCH_PLANNER_RUN = "no such planner run";

const runs = new Map<string, PlannerRun>();

/**
 * Open a planner run for the length of `fn`. The run is always deleted when
 * `fn` settles, so a late tool call from a lingering MCP child gets a 404.
 */
export async function withPlannerRun<T>(input: PlannerRunInput, fn: (runId: string) => Promise<T>): Promise<T> {
  const id = crypto.randomUUID();
  runs.set(id, {
    repo: input.repo,
    issueRef: input.issueRef,
    stage: input.stage,
    allowedRepos: [...input.allowedRepos],
    allowedDuplicates: [...(input.allowedDuplicates ?? [])],
    allowedTransfers: [...(input.allowedTransfers ?? [])],
    allowOutcomes: input.allowOutcomes ?? true,
    submission: null,
    rejectedCalls: 0,
    lastRejection: null,
  });
  try {
    return await fn(id);
  } finally {
    runs.delete(id);
  }
}

export function hasPlannerRun(runId: string): boolean {
  return runs.has(runId);
}

export function getSubmission(runId: string): PlannerSubmission | null {
  return runs.get(runId)?.submission ?? null;
}

/** How many tool calls `runId` rejected and the last error text; zero/null for an unknown run. */
export function getRunRejections(runId: string): { count: number; last: string | null } {
  const run = runs.get(runId);
  return { count: run?.rejectedCalls ?? 0, last: run?.lastRejection ?? null };
}

/** Record a refused call on its run, then pass the result through. */
function counted(runId: string, result: SubmitResult): SubmitResult {
  if (!result.ok) {
    const run = runs.get(runId);
    if (run) {
      run.rejectedCalls += 1;
      run.lastRejection = result.error;
    }
  }
  return result;
}

/**
 * The HTTP handler behind `POST …/planner-runs/:id/<route>`, shared by the
 * service (`server.ts`) and the agent pod's loopback listener: 404 with
 * {@link NO_SUCH_PLANNER_RUN} for an unknown run, 400 for a body that is not
 * JSON or that `submit` refuses, else `{ ok: true }`.
 */
export function plannerRunHandler(submit: (runId: string, input: unknown) => SubmitResult): (c: Context) => Promise<Response> {
  return async (c) => {
    const runId = c.req.param("id") ?? "";
    if (!hasPlannerRun(runId)) return c.json({ error: NO_SUCH_PLANNER_RUN }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const result = submit(runId, body);
    if (!result.ok) return c.json({ error: result.error }, result.error === NO_SUCH_PLANNER_RUN ? 404 : 400);
    return c.json({ ok: true });
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A positive issue number from `458` or `"#458"`, or a native id; else null. */
function coerceIssueRef(value: unknown): IssueRef | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const ref = parseIssueRef(value);
  return typeof ref === "number" && ref <= 0 ? null : ref;
}

/** Validate a plan payload against `run`; returns the canonical submission or an error. */
function validatePlan(run: PlannerRun, input: unknown, stage: PlannerStage): PlanSubmission | string {
  if (!isRecord(input)) return "the plan must be an object";
  const plan = typeof input["plan"] === "string" ? stripLeadingPlanHeader(input["plan"]) : "";
  if (!plan) return "`plan` is empty — pass the complete plan text";

  const rawPrs = input["prs"];
  if (!Array.isArray(rawPrs) || rawPrs.length === 0) {
    return "`prs` must list at least one PR: one {repo, title} entry per `### PR N:` section, in order (a single-PR plan has one entry)";
  }
  if (rawPrs.length > MAX_PLANNED_PRS) return `\`prs\` has ${rawPrs.length} entries — at most ${MAX_PLANNED_PRS} are allowed`;
  const prs: PlannedPR[] = [];
  for (const [i, entry] of rawPrs.entries()) {
    const n = i + 1;
    if (!isRecord(entry)) return `prs[${n}] must be an object with \`repo\` and \`title\``;
    const repo = typeof entry["repo"] === "string" ? entry["repo"].trim() : "";
    const title = typeof entry["title"] === "string" ? entry["title"].trim().slice(0, MAX_PLANNED_PR_TITLE_CHARS).trim() : "";
    if (!repo) return `prs[${n}].repo is empty`;
    if (!title) return `prs[${n}].title is empty`;
    // Case-insensitive match returning the CANONICAL spelling — never trust the model's casing.
    const canonical = run.allowedRepos.find((r) => r.toLowerCase() === repo.toLowerCase());
    if (!canonical) {
      return `prs[${n}].repo "${repo}" is not one of this issue's repositories: ${run.allowedRepos.join(", ") || "(none)"}`;
    }
    let dependsOn: number[] | null = null;
    const rawDeps = entry["depends_on"];
    if (rawDeps !== undefined && rawDeps !== null) {
      // Only earlier positions: that keeps the dependency graph acyclic.
      const range = n === 1 ? "must be [] for the first PR" : `may only name positions 1..${n - 1}`;
      if (!Array.isArray(rawDeps) || !rawDeps.every((d) => Number.isInteger(d) && d >= 1 && d < n)) {
        return `prs[${n}].depends_on must be an array of earlier positions — it ${range}`;
      }
      dependsOn = [...new Set(rawDeps as number[])].sort((a, b) => a - b);
    }
    prs.push({ repo: canonical, title, dependsOn });
  }
  // The stored list decides the phase count, so a list that disagrees with the
  // plan text would silently drop (or invent) steps — reject it while the agent
  // can still fix it. A plan with no `### PR N:` headers counts as one section.
  const sections = parsePlan(plan).totalPhases;
  if (prs.length !== sections) {
    return `\`prs\` has ${prs.length} entr${prs.length === 1 ? "y" : "ies"} but the plan has ${sections} \`### PR N:\` section${sections === 1 ? "" : "s"} — list one entry per section, in order`;
  }

  const impl = typeof input["implementation_model"] === "string" ? input["implementation_model"].trim().toLowerCase() : "";
  if (!(IMPLEMENTATION_MODELS as readonly string[]).includes(impl)) {
    return `\`implementation_model\` must be one of ${IMPLEMENTATION_MODELS.join(", ")}`;
  }
  const review = typeof input["review_model"] === "string" ? input["review_model"].trim().toLowerCase() : "";
  if (!(REVIEW_MODELS as readonly string[]).includes(review)) {
    return `\`review_model\` must be one of ${REVIEW_MODELS.join(", ")}`;
  }

  let targetPr: number | null = null;
  const rawTarget = input["target_pr"];
  if (rawTarget !== undefined && rawTarget !== null) {
    const n = typeof rawTarget === "string" ? Number(rawTarget.trim().replace(/^#/, "")) : rawTarget;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return "`target_pr` must be a positive PR number";
    if (prs.length !== 1) return `\`target_pr\` is only allowed on a single-PR plan — this plan lists ${prs.length} PRs`;
    targetPr = n;
  }

  const response = optionalString(input["response"]);
  if (response !== null && stage !== "refine") {
    return "`response` is only accepted when refining a plan after feedback — omit it";
  }

  return {
    kind: "plan",
    plan,
    prs,
    implementationModel: impl as ImplementationModel,
    reviewModel: review as ReviewModel,
    targetPr,
    response,
  };
}

export function submitPlan(runId: string, input: unknown): SubmitResult {
  return counted(runId, submitPlanImpl(runId, input));
}

function submitPlanImpl(runId: string, input: unknown): SubmitResult {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: NO_SUCH_PLANNER_RUN };
  if (run.stage === "step_back") return { ok: false, error: "this is a step-back pass — report through claws_step_back_verdict instead" };
  if (run.submission?.kind === "outcome") {
    return { ok: false, error: "an outcome was already reported in this run — a run reports either a plan or an outcome, not both" };
  }
  const result = validatePlan(run, input, run.stage);
  if (typeof result === "string") return { ok: false, error: result };
  run.submission = result;
  return { ok: true };
}

export function submitOutcome(runId: string, input: unknown): SubmitResult {
  return counted(runId, submitOutcomeImpl(runId, input));
}

function submitOutcomeImpl(runId: string, input: unknown): SubmitResult {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: NO_SUCH_PLANNER_RUN };
  if (run.stage === "step_back") return { ok: false, error: "this is a step-back pass — report through claws_step_back_verdict instead" };
  if (!run.allowOutcomes) return { ok: false, error: "this pass cannot report an outcome — save the plan with claws_save_plan" };
  if (run.submission?.kind === "plan") {
    return { ok: false, error: "a plan was already saved in this run — a run reports either a plan or an outcome, not both" };
  }
  if (!isRecord(input)) return { ok: false, error: "the outcome must be an object" };
  const explanation = optionalString(input["explanation"]);
  if (!explanation) return { ok: false, error: "`explanation` is required — 2-4 sentences saying why" };

  const kind = typeof input["outcome"] === "string" ? input["outcome"].trim().toLowerCase() : "";
  let outcome: PlannerOutcome;
  switch (kind) {
    case "duplicate": {
      if (run.allowedDuplicates.length === 0) return { ok: false, error: "no duplicate candidates were offered in this run — the duplicate outcome is not available" };
      const n = coerceIssueRef(input["duplicate_of"]);
      if (n === null || !run.allowedDuplicates.some((c) => sameIssueRef(c, n))) {
        return { ok: false, error: `duplicate_of ${JSON.stringify(input["duplicate_of"])} is not one of the candidates offered: ${run.allowedDuplicates.map((c) => `#${c}`).join(", ")}` };
      }
      outcome = { kind: "duplicate", duplicateOf: n };
      break;
    }
    case "transfer": {
      if (run.allowedTransfers.length === 0) return { ok: false, error: "no transfer destinations were offered in this run — the transfer outcome is not available" };
      const value = typeof input["transfer_to"] === "string" ? input["transfer_to"].trim() : "";
      // Case-insensitive match returning the CANONICAL spelling — never trust the model's casing.
      const canonical = value ? run.allowedTransfers.find((r) => r.toLowerCase() === value.toLowerCase()) : undefined;
      if (!canonical) {
        return { ok: false, error: `transfer_to ${JSON.stringify(input["transfer_to"])} is not an allowed destination: ${run.allowedTransfers.join(", ")}` };
      }
      outcome = { kind: "transfer", transferTo: canonical };
      break;
    }
    case "blocked":
      outcome = { kind: "blocked" };
      break;
    case "no_code_changes":
      outcome = { kind: "no_code_changes" };
      break;
    default:
      return { ok: false, error: `unknown outcome ${JSON.stringify(input["outcome"])} — use one of: ${[...(run.allowedDuplicates.length ? ["duplicate"] : []), ...(run.allowedTransfers.length ? ["transfer"] : []), "blocked", "no_code_changes"].join(", ")}` };
  }
  run.submission = { kind: "outcome", outcome, explanation };
  return { ok: true };
}

export function submitStepBack(runId: string, input: unknown): SubmitResult {
  return counted(runId, submitStepBackImpl(runId, input));
}

function submitStepBackImpl(runId: string, input: unknown): SubmitResult {
  const run = runs.get(runId);
  if (!run) return { ok: false, error: NO_SUCH_PLANNER_RUN };
  if (run.stage !== "step_back") return { ok: false, error: "claws_step_back_verdict is only available in a step-back pass" };
  if (!isRecord(input)) return { ok: false, error: "the verdict must be an object" };
  const verdict = typeof input["verdict"] === "string" ? input["verdict"].trim().toLowerCase() : "";
  if (verdict !== "sound" && verdict !== "reconsider") return { ok: false, error: "`verdict` must be \"sound\" or \"reconsider\"" };
  const critique = optionalString(input["critique"]);
  let revised: PlanSubmission | null = null;
  if (input["revised"] !== undefined && input["revised"] !== null) {
    if (verdict === "sound") return { ok: false, error: "a `revised` plan is only accepted with verdict \"reconsider\"" };
    const result = validatePlan(run, input["revised"], "step_back");
    if (typeof result === "string") return { ok: false, error: `revised: ${result}` };
    revised = result;
  }
  run.submission = { kind: "step_back", verdict, critique, revised };
  return { ok: true };
}
