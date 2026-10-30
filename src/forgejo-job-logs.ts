/**
 * Readable Forgejo Actions job logs for sessions and agents — the service side
 * of the `claws_forgejo_job_logs` claws-state tool (#clw_01M4BYY8SZ9CY5NBC20ZHAPXFW).
 *
 * Reads with the bot token through the job-log API patch in our Forgejo image,
 * so no token reaches the caller. Forgejo masks secrets on the runner before
 * upload; the stored text is returned as-is apart from ANSI stripping and the
 * size cap, so masked values stay `***`.
 */

import {
  ForgejoActionNotFoundError,
  ForgejoJobLogEndpointUnavailableError,
  getActionJobStepLogs,
  getActionRunJobs,
  selectFailedJobs,
  type ForgejoActionJob,
} from "./forgejo.js";
import { listRepos } from "./github.js";
import { excerptLog, stripAnsi } from "./log-excerpt.js";

/** Cap on the returned text, in characters; a longer log keeps its head and (mostly) its tail. */
export const FORGEJO_JOB_LOG_MAX_CHARS = 60_000;

/** A failure the caller can act on, with the HTTP status the API route answers with. */
export class ForgejoJobLogsError extends Error {
  constructor(readonly status: 400 | 404 | 502, message: string) {
    super(message);
    this.name = "ForgejoJobLogsError";
  }
}

export interface ForgejoJobLogsRequest {
  repo: string;
  /** The run number shown in the web URL (`/actions/runs/3`). */
  run: number;
  /** 0-based job index or exact job name; omitted selects the failed jobs. */
  job?: number | string;
  /** Every step of the selected jobs, not just the failed ones. */
  allSteps?: boolean;
  /**
   * One step of each selected job, passed or not: a number matches the step
   * index, a string the first step whose name contains it (case-insensitive).
   */
  step?: number | string;
  /** Case-insensitive regex; keeps only matching lines (plus {@link context}) of each step. */
  grep?: string;
  /** Lines kept either side of a `grep` match (default 2, max 20). */
  context?: number;
}

export interface ForgejoJobLogsResult {
  text: string;
  truncated: boolean;
}

const FAILED = "failure";

/** Default and maximum `context` lines either side of a `grep` match. */
export const FORGEJO_JOB_LOG_GREP_CONTEXT_DEFAULT = 2;
export const FORGEJO_JOB_LOG_GREP_CONTEXT_MAX = 20;

interface StepLike {
  index: number;
  name: string;
  status: string;
}

function describeSteps(steps: StepLike[]): string {
  if (steps.length === 0) return "(none)";
  return steps.map((s) => `${s.index} "${s.name}" (${s.status})`).join(", ");
}

function findStep<T extends StepLike>(steps: T[], step: number | string): T | undefined {
  if (typeof step === "number") return steps.find((s) => s.index === step);
  const wanted = step.toLowerCase();
  return steps.find((s) => s.name.toLowerCase().includes(wanted));
}

/** Longest prefix of a log line `grep` tests, so a backtracking pattern cannot stall the service on a huge line. */
const GREP_LINE_MAX_CHARS = 500;

/** A group containing an unbounded quantifier that is itself repeated, e.g. `(a+)+`: exponential backtracking. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\})/;

function compileGrep(grep: string): RegExp {
  if (NESTED_QUANTIFIER.test(grep)) {
    throw new ForgejoJobLogsError(400, "grep must not repeat a group that already contains an unbounded quantifier (e.g. (a+)+)");
  }
  try {
    return new RegExp(grep, "i");
  } catch (err) {
    throw new ForgejoJobLogsError(400, `grep is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The lines of `log` matching `pattern`, each with `context` lines either
 * side; overlapping or adjacent windows merge and gaps between them print `--`.
 * Null when nothing matches.
 */
export function grepLog(log: string, pattern: RegExp, context: number): string | null {
  const lines = log.replace(/\n$/, "").split("\n");
  const windows: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    // Bound the work a pathological pattern can do on one line.
    if (!pattern.test(lines[i].length > GREP_LINE_MAX_CHARS ? lines[i].slice(0, GREP_LINE_MAX_CHARS) : lines[i])) continue;
    const start = Math.max(0, i - context);
    const end = Math.min(lines.length - 1, i + context);
    const last = windows[windows.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else windows.push([start, end]);
  }
  if (windows.length === 0) return null;
  return windows.map(([start, end]) => lines.slice(start, end + 1).join("\n")).join("\n--\n");
}

function describeJobs(jobs: ForgejoActionJob[]): string {
  if (jobs.length === 0) return "(none)";
  return jobs.map((j) => `${j.index} "${j.name}" (${j.status})`).join(", ");
}

/** Resolve `repo` to a managed Forgejo repo's canonical full name, or throw why not. */
async function resolveForgejoRepo(repo: string): Promise<string> {
  const wanted = repo.toLowerCase();
  const managed = (await listRepos()).find((r) => r.fullName.toLowerCase() === wanted);
  if (!managed) throw new ForgejoJobLogsError(404, `${repo} is not a repo Claws manages`);
  return managed.fullName;
}

function selectJobs(jobs: ForgejoActionJob[], job: number | string | undefined, run: number): ForgejoActionJob[] {
  if (job !== undefined) {
    const found = typeof job === "number" ? jobs.find((j) => j.index === job) : jobs.find((j) => j.name === job);
    if (!found) {
      throw new ForgejoJobLogsError(404, `run ${run} has no job ${typeof job === "number" ? job : `"${job}"`}; its jobs are: ${describeJobs(jobs)}`);
    }
    return [found];
  }
  const failed = selectFailedJobs(jobs);
  if (failed.length > 0) return failed;
  throw new ForgejoJobLogsError(
    404,
    `run ${run} has no failed job; its jobs are: ${describeJobs(jobs)} — pass \`job\` (index or name) to read one`,
  );
}

function wrapForgejoError(err: unknown, notFound: string): never {
  if (err instanceof ForgejoActionNotFoundError) throw new ForgejoJobLogsError(404, notFound);
  if (err instanceof ForgejoJobLogEndpointUnavailableError) throw new ForgejoJobLogsError(502, err.message);
  throw new ForgejoJobLogsError(502, err instanceof Error ? err.message : String(err));
}

/**
 * The log of a Forgejo Actions run as plain text: by default the failed steps
 * of the failed jobs (cancelled ones when none failed), ANSI-stripped and capped
 * at {@link FORGEJO_JOB_LOG_MAX_CHARS}. `step` and `grep` narrow the text
 * before that cap, so a middle step of a long job stays reachable. Throws
 * {@link ForgejoJobLogsError}.
 */
export async function fetchForgejoJobLogs(req: ForgejoJobLogsRequest): Promise<ForgejoJobLogsResult> {
  const pattern = req.grep !== undefined ? compileGrep(req.grep) : null;
  const context = Math.min(FORGEJO_JOB_LOG_GREP_CONTEXT_MAX, Math.max(0, req.context ?? FORGEJO_JOB_LOG_GREP_CONTEXT_DEFAULT));
  const repo = await resolveForgejoRepo(req.repo);

  let runJobs;
  try {
    runJobs = await getActionRunJobs(repo, req.run);
  } catch (err) {
    wrapForgejoError(err, `${repo} has no Actions run ${req.run}`);
  }
  const jobs = selectJobs(runJobs.jobs, req.job, req.run);

  const header = `${repo} run ${runJobs.run.index}${runJobs.run.title ? ` "${runJobs.run.title}"` : ""} (${runJobs.run.status})${runJobs.run.htmlUrl ? ` ${runJobs.run.htmlUrl}` : ""}`;
  const parts: string[] = [header];
  let anyLog = false;
  const unmatchedSteps: string[] = [];
  for (const job of jobs) {
    let logs;
    try {
      logs = await getActionJobStepLogs(repo, req.run, job.index);
    } catch (err) {
      wrapForgejoError(err, `run ${req.run} has no job ${job.index}; its jobs are: ${describeJobs(runJobs.jobs)}`);
    }
    let steps;
    if (req.step !== undefined) {
      const found = findStep(logs.steps, req.step);
      if (!found) {
        unmatchedSteps.push(`job ${job.index} "${job.name}" steps: ${describeSteps(logs.steps)}`);
        continue;
      }
      steps = [found];
    } else {
      const failedSteps = logs.steps.filter((s) => s.status === FAILED);
      steps = req.allSteps || failedSteps.length === 0 ? logs.steps : failedSteps;
    }
    parts.push("", `=== job ${job.index} "${job.name}" (${job.status})`);
    for (const step of steps) {
      if (step.log.trim()) anyLog = true;
      parts.push(`--- step ${step.index} "${step.name}" (${step.status})`);
      if (!step.log) continue;
      if (pattern) parts.push(grepLog(step.log, pattern, context) ?? "(no matching lines)");
      else parts.push(step.log.replace(/\n$/, ""));
    }
  }
  if (req.step !== undefined && unmatchedSteps.length === jobs.length) {
    const wanted = typeof req.step === "number" ? String(req.step) : `"${req.step}"`;
    throw new ForgejoJobLogsError(404, `run ${req.run} has no step ${wanted}; ${unmatchedSteps.join("; ")}`);
  }
  if (!anyLog) {
    throw new ForgejoJobLogsError(
      404,
      `run ${req.run}: the selected steps of job(s) ${describeJobs(jobs)} have no log text${req.allSteps ? "" : " — pass all_steps to read every step"}`,
    );
  }

  const text = stripAnsi(parts.join("\n"));
  const truncated = text.length > FORGEJO_JOB_LOG_MAX_CHARS;
  return { text: excerptLog(text, FORGEJO_JOB_LOG_MAX_CHARS), truncated };
}
