import { AgentTimeoutError, AgentMemoryLimitError } from "./claude.js";
import { CLAUDE_TIMEOUT_MS, ITEM_TIMEOUT_OVERRIDES, writeConfig, type ConfigFile } from "./config.js";
import * as db from "./db.js";
import * as gh from "./github.js";
import { reportTimeoutOnItem, reportMemoryLimitOnItem } from "./error-reporter.js";
import * as log from "./log.js";

const TIMEOUT_THRESHOLD = 3; // Skip after 3 timeouts in window
const MEMORY_LIMIT_THRESHOLD = 3; // Skip after 3 memory-limit kills in window
const TIMEOUT_ESCALATION_FACTOR = 1.5;
const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hour cap

export function getItemTimeoutMs(repo: string, itemNumber: number): number | undefined {
  const override = ITEM_TIMEOUT_OVERRIDES.find(
    (o) => o.repo === repo && o.number === itemNumber,
  )?.timeoutMs;
  // Legacy overrides from the old 30-min default era may be shorter than
  // the current 6h default — ignore them so items aren't cut short.
  if (override !== undefined && override <= CLAUDE_TIMEOUT_MS) return undefined;
  return override;
}

function escalateTimeout(repo: string, itemNumber: number): number {
  const current = getItemTimeoutMs(repo, itemNumber) ?? CLAUDE_TIMEOUT_MS;
  const next = Math.min(Math.round(current * TIMEOUT_ESCALATION_FACTOR), MAX_TIMEOUT_MS);

  const overrides = [...(ITEM_TIMEOUT_OVERRIDES as Array<{ repo: string; number: number; timeoutMs: number }>)];
  const idx = overrides.findIndex((o) => o.repo === repo && o.number === itemNumber);
  if (idx >= 0) {
    overrides[idx] = { repo, number: itemNumber, timeoutMs: next };
  } else {
    overrides.push({ repo, number: itemNumber, timeoutMs: next });
  }
  writeConfig({ itemTimeoutOverrides: overrides } as Partial<ConfigFile>);

  return next;
}

export async function handleMemoryLimitIfApplicable(
  jobName: string,
  repo: string,
  itemNumber: number,
  error: unknown,
): Promise<void> {
  if (!(error instanceof AgentMemoryLimitError)) return;
  // Repo-level jobs (improvement-identifier, doc-maintainer) use itemNumber 0 —
  // there is no issue/PR to comment on.
  if (itemNumber <= 0) {
    log.warn(`[${jobName}] Memory limit hit on repo-level run (no item to report on)`);
    return;
  }
  const count = db.countRecentMemoryLimits(repo, itemNumber);
  const shouldSkip = count >= MEMORY_LIMIT_THRESHOLD;
  if (shouldSkip) {
    gh.skipItem(repo, itemNumber);
    log.warn(`[${jobName}] Auto-skipped ${repo}#${itemNumber} after ${count} memory-limit kills`);
  }
  try {
    await reportMemoryLimitOnItem(repo, itemNumber, error, count, shouldSkip);
  } catch (commentErr) {
    log.warn(`[${jobName}] Failed to post memory-limit comment on ${repo}#${itemNumber}: ${commentErr}`);
  }
}

export async function handleTimeoutIfApplicable(
  jobName: string,
  repo: string,
  itemNumber: number,
  error: unknown,
): Promise<void> {
  if (!(error instanceof AgentTimeoutError)) return;

  const count = db.countRecentTimeouts(repo, itemNumber);
  const shouldSkip = count >= TIMEOUT_THRESHOLD;
  let newTimeoutMs: number | null = null;

  if (shouldSkip) {
    gh.skipItem(repo, itemNumber);
    log.warn(`[${jobName}] Auto-skipped ${repo}#${itemNumber} after ${count} timeouts`);
  } else {
    newTimeoutMs = escalateTimeout(repo, itemNumber);
    log.info(`[${jobName}] Escalated timeout for ${repo}#${itemNumber} to ${Math.round(newTimeoutMs / 60_000)}min`);
  }

  try {
    await reportTimeoutOnItem(repo, itemNumber, count, error, shouldSkip, newTimeoutMs);
  } catch (commentErr) {
    log.warn(`[${jobName}] Failed to post timeout comment on ${repo}#${itemNumber}: ${commentErr}`);
  }
}
