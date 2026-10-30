import type { ActivationState } from "./config.js";
import type { Job } from "./scheduler.js";

export const STAGING_PIPELINE_JOB_NAMES: ReadonlySet<string> = new Set([
  "issue-dispatcher",
  "pr-dispatcher",
  "auto-merger",
]);

export function selectStartupJobs(jobs: readonly Job[], activationState: ActivationState): Job[] {
  if (activationState === "active") return [...jobs];
  if (activationState === "staging") {
    return jobs.filter((job) => STAGING_PIPELINE_JOB_NAMES.has(job.name));
  }
  return [];
}

export function shouldStartWorkersForActivation(activationState: ActivationState): boolean {
  return activationState === "active" || activationState === "staging";
}

export function canRunJobForActivation(jobName: string, activationState: ActivationState): boolean {
  if (activationState === "active") return true;
  if (activationState === "staging") return STAGING_PIPELINE_JOB_NAMES.has(jobName);
  return false;
}
