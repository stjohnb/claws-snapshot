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
  ForgejoJobAttemptUnsupportedError,
  ForgejoJobLogEndpointUnavailableError,
  getActionJobStepLogs,
  getActionRunJobs,
  selectFailedJobs,
  type ForgejoActionJob,
  type ForgejoActionJobAttempt,
  type ForgejoActionJobStepLogs,
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
  /**
   * 0-based job index or exact job name; omitted selects the failed jobs, or,
   * when every job passed after a re-run, each re-run job's newest failed attempt.
   */
  job?: number | string;
  /** Which attempt of `job` to read (1 is the first run, each re-run adds one); requires `job`. Omitted reads the latest. */
  attempt?: number;
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
const CANCELLED = "cancelled";

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

/** Why a step has no stored text, so an empty step reads as an answer rather than a failure. */
function emptyStepReason(status: string): string {
  if (status === "cancelled") return "(no log stored: cancelled before it ran, or its output was not uploaded before the cancel)";
  if (status === "skipped") return "(skipped)";
  return "(no output)";
}

function describeJobs(jobs: ForgejoActionJob[]): string {
  if (jobs.length === 0) return "(none)";
  return jobs.map((j) => `${j.index} "${j.name}" (${j.status})`).join(", ");
}

/** Resolve `repo` to a managed Forgejo repo's canonical full name, or throw why not. */
export async function resolveForgejoRepo(repo: string): Promise<string> {
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
  return selectFailedJobs(jobs);
}

/** One job to render: which attempt to read (undefined = latest) and an optional note under its header. */
interface JobPick {
  job: ForgejoActionJob;
  attempt?: number;
  /** Logs already read while choosing, reused instead of a second read. */
  logs?: ForgejoActionJobStepLogs;
  note?: string;
}

/** The newest attempt that failed, else the newest cancelled one; null when every attempt passed. */
function newestBadAttempt(attempts: ForgejoActionJobAttempt[]): ForgejoActionJobAttempt | null {
  const newestFirst = [...attempts].sort((a, b) => b.number - a.number);
  return newestFirst.find((a) => a.status === FAILED) ?? newestFirst.find((a) => a.status === CANCELLED) ?? null;
}

/**
 * The green re-run fallback: for each job re-run in `jobs` (attempt > 1), its
 * newest failed (else cancelled) attempt. The common case is one read — the
 * attempt just before the latest, whose response also lists every attempt — and
 * a second only when a different attempt is the failed one. An attempt the
 * image says it lacks (a queued re-run, an expired log) falls back to the latest
 * read's `attempts`, so a re-run still waiting for a runner keeps attempt N.
 */
async function selectFailedAttempts(repo: string, run: number, jobs: ForgejoActionJob[]): Promise<JobPick[]> {
  const picks: JobPick[] = [];
  for (const job of jobs) {
    const latest = job.attempt ?? 0;
    if (latest <= 1) continue;
    let previous: ForgejoActionJobStepLogs | undefined;
    try {
      previous = await getActionJobStepLogs(repo, run, job.index, latest - 1);
    } catch (err) {
      if (!(err instanceof ForgejoActionNotFoundError)) throw err;
    }
    const attempts = previous?.attempts ?? (await getActionJobStepLogs(repo, run, job.index)).attempts ?? [];
    const target = newestBadAttempt(attempts);
    if (!target) continue;
    picks.push({
      job: { ...job, status: target.status },
      attempt: target.number,
      logs: previous?.attempt === target.number ? previous : undefined,
      note: `latest attempt passed; showing failed attempt ${target.number}`,
    });
  }
  return picks;
}

/** The `attempt N of M` suffix of a job header, and the line naming the job's other attempts; empty when the image reports none. */
function describeAttempts(job: ForgejoActionJob, logs: ForgejoActionJobStepLogs): { suffix: string; others: string | null } {
  const shown = logs.attempt;
  const attempts = logs.attempts ?? [];
  const total = Math.max(job.attempt ?? 0, shown ?? 0, ...attempts.map((a) => a.number));
  const suffix = shown !== undefined && total > 0 ? ` attempt ${shown} of ${total}` : "";
  const others = [...attempts].sort((a, b) => b.number - a.number).filter((a) => a.number !== shown);
  if (others.length === 0) return { suffix, others: null };
  return {
    suffix,
    others: `other attempts: ${others.map((a) => `${a.number} (${a.status})`).join(", ")} — pass job and attempt to read one`,
  };
}

function wrapForgejoError(err: unknown, notFound: string, attemptNotFound = notFound): never {
  if (err instanceof ForgejoActionNotFoundError) throw new ForgejoJobLogsError(404, err.kind === "attempt" ? attemptNotFound : notFound);
  if (err instanceof ForgejoJobAttemptUnsupportedError) throw new ForgejoJobLogsError(502, err.message);
  if (err instanceof ForgejoJobLogEndpointUnavailableError) throw new ForgejoJobLogsError(502, err.message);
  throw new ForgejoJobLogsError(502, err instanceof Error ? err.message : String(err));
}

/**
 * The log of a Forgejo Actions run as plain text: by default the failed steps
 * of the failed jobs (cancelled ones when none failed), ANSI-stripped and capped
 * at {@link FORGEJO_JOB_LOG_MAX_CHARS}. When no job failed but some were
 * re-run, each re-run job's newest failed attempt is shown instead, so a green
 * re-run does not hide the failure; `job` with `attempt` reads any attempt. `step` and `grep` narrow the text
 * before that cap, so a middle step of a long job stays reachable. Throws
 * {@link ForgejoJobLogsError}.
 */
export async function fetchForgejoJobLogs(req: ForgejoJobLogsRequest): Promise<ForgejoJobLogsResult> {
  if (req.attempt !== undefined && req.job === undefined) {
    throw new ForgejoJobLogsError(400, "attempt requires job (a job index or name): attempts are numbered per job");
  }
  if (req.attempt !== undefined && (!Number.isInteger(req.attempt) || req.attempt < 1)) {
    throw new ForgejoJobLogsError(400, "attempt must be a positive integer (1 is the first run)");
  }
  const pattern = req.grep !== undefined ? compileGrep(req.grep) : null;
  const context = Math.min(FORGEJO_JOB_LOG_GREP_CONTEXT_MAX, Math.max(0, req.context ?? FORGEJO_JOB_LOG_GREP_CONTEXT_DEFAULT));
  const repo = await resolveForgejoRepo(req.repo);

  let runJobs;
  try {
    runJobs = await getActionRunJobs(repo, req.run);
  } catch (err) {
    wrapForgejoError(err, `${repo} has no Actions run ${req.run}`);
  }
  const selected = selectJobs(runJobs.jobs, req.job, req.run);
  let picks: JobPick[] = selected.map((job) => ({ job, attempt: req.attempt }));
  if (picks.length === 0) {
    try {
      picks = await selectFailedAttempts(repo, req.run, runJobs.jobs);
    } catch (err) {
      wrapForgejoError(err, `${repo} has no Actions run ${req.run}`);
    }
    if (picks.length === 0) {
      const rerun = runJobs.jobs.filter((j) => (j.attempt ?? 0) > 1);
      const rerunNote = rerun.length > 0
        ? `; re-run jobs ${rerun.map((j) => `${j.index} "${j.name}" (attempt ${j.attempt})`).join(", ")} have no earlier failed attempt`
        : "";
      throw new ForgejoJobLogsError(
        404,
        `run ${req.run} has no failed job; its jobs are: ${describeJobs(runJobs.jobs)}${rerunNote} — pass \`job\` (index or name) to read one`,
      );
    }
  }
  const jobs = picks.map((p) => p.job);

  const header = `${repo} run ${runJobs.run.index}${runJobs.run.title ? ` "${runJobs.run.title}"` : ""} (${runJobs.run.status})${runJobs.run.htmlUrl ? ` ${runJobs.run.htmlUrl}` : ""}`;
  const parts: string[] = [header];
  let anyLog = false;
  const unmatchedSteps: string[] = [];
  for (const pick of picks) {
    const { job } = pick;
    let logs = pick.logs;
    if (!logs) {
      try {
        logs = await getActionJobStepLogs(repo, req.run, job.index, pick.attempt);
      } catch (err) {
        wrapForgejoError(
          err,
          `run ${req.run} has no job ${job.index}; its jobs are: ${describeJobs(runJobs.jobs)}`,
          `job ${job.index} "${job.name}" of run ${req.run} has no attempt ${pick.attempt}${job.attempt ? ` with a log; its latest attempt is ${job.attempt}` : ""}`,
        );
      }
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
    const { suffix, others } = describeAttempts(job, logs);
    const status = pick.attempt !== undefined ? (logs.attempts?.find((a) => a.number === logs.attempt)?.status ?? job.status) : job.status;
    parts.push("", `=== job ${job.index} "${job.name}" (${status})${suffix}`);
    if (pick.note) parts.push(pick.note);
    if (others) parts.push(others);
    for (const step of steps) {
      if (step.log.trim()) anyLog = true;
      parts.push(`--- step ${step.index} "${step.name}" (${step.status})`);
      if (!step.log.trim()) {
        parts.push(emptyStepReason(step.status));
        continue;
      }
      if (pattern) parts.push(grepLog(step.log, pattern, context) ?? "(no matching lines)");
      else parts.push(step.log.replace(/\n$/, ""));
    }
  }
  if (req.step !== undefined && unmatchedSteps.length === jobs.length) {
    const wanted = typeof req.step === "number" ? String(req.step) : `"${req.step}"`;
    throw new ForgejoJobLogsError(404, `run ${req.run} has no step ${wanted}; ${unmatchedSteps.join("; ")}`);
  }
  if (!anyLog) parts.push("", "(none of the selected steps stored any log text)");

  const text = stripAnsi(parts.join("\n"));
  const truncated = text.length > FORGEJO_JOB_LOG_MAX_CHARS;
  return { text: excerptLog(text, FORGEJO_JOB_LOG_MAX_CHARS), truncated };
}
