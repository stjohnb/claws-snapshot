/**
 * One Forgejo Actions run's status for sessions and agents — the service side of
 * the `claws_forgejo_run` claws-state tool (#clw_01M6V4PMQFEBTSRJ1VZDZ85MN6).
 *
 * Forgejo's `GET …/actions/runs/{x}` takes the global run id, not the run number
 * shown in the web URL, so the run is looked up through the list route's
 * `run_number` filter ({@link getActionRunByNumber}).
 */

import { getActionRunByNumber, getActionRunJobs, type ForgejoActionJob } from "./forgejo.js";
import { ForgejoJobLogsError, resolveForgejoRepo } from "./forgejo-job-logs.js";

export interface ForgejoRunRequest {
  repo: string;
  /** The run number shown in the web URL (`/actions/runs/3`). */
  run: number;
}

export interface ForgejoRunResult {
  repo: string;
  run: number;
  id: number;
  workflow: string;
  title: string | null;
  status: string;
  /** The real trigger (`trigger_event`, else `event`). */
  event: string;
  /** Forgejo's raw `event`, which reads `push` for a scheduled run. */
  reported_event: string;
  ref: string | null;
  head_sha: string | null;
  created: string | null;
  started: string | null;
  stopped: string | null;
  html_url: string | null;
  jobs: ForgejoActionJob[] | null;
  jobs_error?: string;
}

/** Status, true trigger, timings and job statuses of a run. Throws {@link ForgejoJobLogsError}. */
export async function fetchForgejoRun(req: ForgejoRunRequest): Promise<ForgejoRunResult> {
  const repo = await resolveForgejoRepo(req.repo);
  let detail;
  try {
    detail = await getActionRunByNumber(repo, req.run);
  } catch (err) {
    throw new ForgejoJobLogsError(502, err instanceof Error ? err.message : String(err));
  }
  if (!detail) throw new ForgejoJobLogsError(404, `${repo} has no Actions run ${req.run}`);
  const result: ForgejoRunResult = {
    repo,
    run: detail.number,
    id: detail.id,
    workflow: detail.workflowId,
    title: detail.title,
    status: detail.status,
    event: detail.event,
    reported_event: detail.reportedEvent,
    ref: detail.ref,
    head_sha: detail.headSha,
    created: detail.created,
    started: detail.started,
    stopped: detail.stopped,
    html_url: detail.htmlUrl,
    jobs: null,
  };
  try {
    result.jobs = (await getActionRunJobs(repo, req.run)).jobs;
  } catch (err) {
    result.jobs_error = err instanceof Error ? err.message : String(err);
  }
  return result;
}
