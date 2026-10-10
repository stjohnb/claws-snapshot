/**
 * Readable Forgejo Actions job logs for sessions and agents — the service side
 * of the `claws_forgejo_job_logs` claws-state tool (#clw_01M4BYY8SZ9CY5NBC20ZHAPXFW).
 *
 * Reads with the bot token through the job-log API patch in our Forgejo image,
 * so no token reaches the caller. Forgejo masks secrets on the runner before
 * upload; the stored text is returned as-is apart from ANSI stripping and the
 * size cap, so masked values stay `***`.
 */

import { isForgejoRepo } from "./config.js";
import {
  ForgejoActionNotFoundError,
  ForgejoJobLogEndpointUnavailableError,
  getActionJobStepLogs,
  getActionRunJobs,
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
}

export interface ForgejoJobLogsResult {
  text: string;
  truncated: boolean;
}

const FAILED = "failure";
const CANCELLED = "cancelled";

function describeJobs(jobs: ForgejoActionJob[]): string {
  if (jobs.length === 0) return "(none)";
  return jobs.map((j) => `${j.index} "${j.name}" (${j.status})`).join(", ");
}

/** Resolve `repo` to a managed Forgejo repo's canonical full name, or throw why not. */
async function resolveForgejoRepo(repo: string): Promise<string> {
  const wanted = repo.toLowerCase();
  const managed = (await listRepos()).find((r) => r.fullName.toLowerCase() === wanted);
  if (!managed) throw new ForgejoJobLogsError(404, `${repo} is not a repo Claws manages`);
  if (!isForgejoRepo(managed.fullName)) {
    throw new ForgejoJobLogsError(
      404,
      `${managed.fullName} is a GitHub repo, not a Forgejo repo — use \`gh run view <id> --repo ${managed.fullName} --log-failed\``,
    );
  }
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
  const failed = jobs.filter((j) => j.status === FAILED);
  if (failed.length > 0) return failed;
  const cancelled = jobs.filter((j) => j.status === CANCELLED);
  if (cancelled.length > 0) return cancelled;
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
 * at {@link FORGEJO_JOB_LOG_MAX_CHARS}. Throws {@link ForgejoJobLogsError}.
 */
export async function fetchForgejoJobLogs(req: ForgejoJobLogsRequest): Promise<ForgejoJobLogsResult> {
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
  for (const job of jobs) {
    let logs;
    try {
      logs = await getActionJobStepLogs(repo, req.run, job.index);
    } catch (err) {
      wrapForgejoError(err, `run ${req.run} has no job ${job.index}; its jobs are: ${describeJobs(runJobs.jobs)}`);
    }
    const failedSteps = logs.steps.filter((s) => s.status === FAILED);
    const steps = req.allSteps || failedSteps.length === 0 ? logs.steps : failedSteps;
    parts.push("", `=== job ${job.index} "${job.name}" (${job.status})`);
    for (const step of steps) {
      if (step.log.trim()) anyLog = true;
      parts.push(`--- step ${step.index} "${step.name}" (${step.status})`);
      if (step.log) parts.push(step.log.replace(/\n$/, ""));
    }
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
