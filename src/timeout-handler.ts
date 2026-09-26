import { canonicalIssueRef, sameIssueRef, type IssueRef } from "./issue-id.js";
import { issueRefAliases } from "./imported-refs.js";
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

export function getItemTimeoutMs(repo: string, itemNumber: IssueRef): number | undefined {
  // `sameIssueRef`, not `===`: `config.ts` canonicalises the stored side, but
  // the caller's ref is whatever an issue body or a URL segment wrote, so a
  // hand-written `"number": "clw_01jbq…"` override would be a silent no-op.
  //
  // Widened to every alias of the caller's ref, so an override written against
  // a forge number survives that issue's import instead of silently reverting
  // to the default (#3245).
  const aliases = issueRefAliases(repo, itemNumber);
  const override = ITEM_TIMEOUT_OVERRIDES.find(
    (o) => o.repo === repo && aliases.some((a) => sameIssueRef(o.number, a)),
  )?.timeoutMs;
  // Legacy overrides from the old 30-min default era may be shorter than
  // the current 6h default — ignore them so items aren't cut short.
  if (override !== undefined && override <= CLAUDE_TIMEOUT_MS) return undefined;
  return override;
}

function escalateTimeout(repo: string, itemNumber: IssueRef): number {
  const current = getItemTimeoutMs(repo, itemNumber) ?? CLAUDE_TIMEOUT_MS;
  const next = Math.min(Math.round(current * TIMEOUT_ESCALATION_FACTOR), MAX_TIMEOUT_MS);

  const overrides = [...(ITEM_TIMEOUT_OVERRIDES as Array<{ repo: string; number: IssueRef; timeoutMs: number }>)];
  // Write the canonical spelling, as `skipItem` does, so re-reading the config
  // is a fixed point and the entry matches the refs the pipeline holds.
  const number = canonicalIssueRef(itemNumber) ?? itemNumber;
  // Locate the existing entry under *every* alias `getItemTimeoutMs` reads, or
  // escalating an imported issue appends a second entry the reader never
  // reaches: `.find` returns the first match, so the pre-import entry would
  // shadow the escalated one forever and every timeout would recompute the
  // same escalation (#3245). Rewriting the matched slot under `number`
  // collapses the pre-import spelling rather than shadowing it.
  const aliases = issueRefAliases(repo, itemNumber);
  const idx = overrides.findIndex((o) => o.repo === repo && aliases.some((a) => sameIssueRef(o.number, a)));
  if (idx >= 0) {
    overrides[idx] = { repo, number, timeoutMs: next };
  } else {
    overrides.push({ repo, number, timeoutMs: next });
  }
  writeConfig({ itemTimeoutOverrides: overrides } as Partial<ConfigFile>);

  return next;
}

export async function handleMemoryLimitIfApplicable(
  jobName: string,
  repo: string,
  itemNumber: IssueRef,
  error: unknown,
): Promise<void> {
  if (!(error instanceof AgentMemoryLimitError)) return;
  // Repo-level jobs (improvement-identifier, doc-maintainer) use itemNumber 0 —
  // there is no issue/PR to comment on.
  if (typeof itemNumber === "number" && itemNumber <= 0) {
    log.warn(`[${jobName}] Memory limit hit on repo-level run (no item to report on)`);
    return;
  }
  const count = await db.countRecentMemoryLimits(repo, itemNumber, error.limitBytes);
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
  itemNumber: IssueRef,
  error: unknown,
): Promise<void> {
  if (!(error instanceof AgentTimeoutError)) return;

  const count = await db.countRecentTimeouts(repo, itemNumber);
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
