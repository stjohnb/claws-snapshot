import { canonicalIssueRef, sameIssueRef, type IssueRef } from "./issue-id.js";
import { issueRefAliases } from "./imported-refs.js";
import { AgentTimeoutError, AgentMemoryLimitError } from "./claude.js";
import { AGENT_WORKER_MEMORY_MAX_BYTES, CLAUDE_TIMEOUT_MS, ITEM_TIMEOUT_OVERRIDES, writeConfig, type ConfigFile } from "./config.js";
import { AGENT_POD_CLASS_ENV, agentPodClassOf, escalateItemToLarge, type AgentPodClass } from "./agent-pod-class.js";
import * as db from "./db.js";
import * as gh from "./github.js";
import { reportTimeoutOnItem, reportMemoryLimitOnItem } from "./error-reporter.js";
import * as log from "./log.js";
import { memoryLimitKillFromError, type MemoryLimitKill } from "./memory-limit-kill.js";

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

async function escalateTimeout(repo: string, itemNumber: IssueRef): Promise<number> {
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
  await writeConfig({ itemTimeoutOverrides: overrides } as Partial<ConfigFile>);

  return next;
}

/** In an agent pod the run knows its size class; elsewhere (in-process) it has none. */
function currentPodClass(): AgentPodClass | undefined {
  return process.env["CLAWS_AGENT_POD_ROW"] ? agentPodClassOf(process.env[AGENT_POD_CLASS_ENV]) : undefined;
}

/**
 * Count an auto-skip for `claws_agent_items_removed_from_queue_total`. A
 * failure (e.g. a pod on a newer image talking to an older controller that
 * refuses the op) only loses the count; the item stays skipped.
 */
async function countRemoval(jobName: string, reason: "memory-limit" | "timeout", podClass: string): Promise<void> {
  try {
    await db.recordItemRemovedFromQueue(jobName, reason, podClass);
  } catch (err) {
    log.warn(`[${jobName}] Could not count the queue removal (${reason}): ${err}`);
  }
}

export async function handleMemoryLimitIfApplicable(
  jobName: string,
  repo: string,
  itemNumber: IssueRef,
  error: unknown,
): Promise<void> {
  if (!(error instanceof AgentMemoryLimitError)) return;
  // A new agent pod runs with the watchdog off, so this is only ever reached in
  // a shared container — or in a pod launched on an older image, which still
  // knows its size class.
  const podClass: AgentPodClass | undefined = process.env["CLAWS_AGENT_POD_ROW"]
    ? agentPodClassOf(process.env[AGENT_POD_CLASS_ENV])
    : undefined;
  // Only a kill at the full cap — not a lowered auxiliary cap — escalates.
  const escalatable = podClass === "default" && error.limitBytes === AGENT_WORKER_MEMORY_MAX_BYTES;
  await handleMemoryLimitKill(jobName, repo, itemNumber, memoryLimitKillFromError(error, podClass, escalatable));
}

/**
 * The one strike / escalate / skip path for a run killed for memory, whether
 * by the shared-container watchdog or by Kubernetes OOM-killing its agent pod.
 *
 * A default-class kill marked `escalatable` adds `Agent: Large` to the item
 * instead of counting a strike, so its re-dispatched run launches large and the
 * three-strike rule only bites at the large limit. Otherwise the kill counts
 * against the same limit: after {@link MEMORY_LIMIT_THRESHOLD} kills in two
 * hours the item is removed from the queue. The failed task must already be
 * recorded (with `memoryLimitBytes`) so it counts. Either way the item gets a
 * "Memory limit reached" comment. Repo-level runs (item 0) are only logged.
 */
export async function handleMemoryLimitKill(
  jobName: string,
  repo: string,
  itemNumber: IssueRef,
  kill: MemoryLimitKill,
): Promise<void> {
  // Repo-level jobs (improvement-identifier, doc-maintainer) use itemNumber 0 —
  // there is no issue/PR to comment on.
  if ((typeof itemNumber === "number" && itemNumber <= 0) || itemNumber === "0") {
    log.warn(`[${jobName}] Memory limit hit on repo-level run (no item to report on)`, { repo, measurement: kill.measurement });
    return;
  }
  if (kill.escalatable && kill.podClass === "default") {
    let escalated = false;
    try {
      escalated = await escalateItemToLarge(repo, itemNumber);
    } catch (err) {
      log.warn(`[${jobName}] Could not escalate ${repo}#${itemNumber} to the large agent pod class: ${err}`);
    }
    if (escalated) {
      try {
        await reportMemoryLimitOnItem(repo, itemNumber, kill, 0, false, { retryingLarger: true });
      } catch (commentErr) {
        log.warn(`[${jobName}] Failed to post memory-limit comment on ${repo}#${itemNumber}: ${commentErr}`);
      }
      return;
    }
  }
  const count = await db.countRecentMemoryLimits(repo, itemNumber, kill.limitBytes > 0 ? kill.limitBytes : undefined);
  const shouldSkip = count >= MEMORY_LIMIT_THRESHOLD;
  if (shouldSkip) {
    await gh.skipItem(repo, itemNumber);
    log.warn(`[${jobName}] Auto-skipped ${repo}#${itemNumber} after ${count} memory-limit kills`);
    await countRemoval(jobName, "memory-limit", kill.podClass ?? "none");
  }
  try {
    await reportMemoryLimitOnItem(repo, itemNumber, kill, count, shouldSkip);
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
    await gh.skipItem(repo, itemNumber);
    log.warn(`[${jobName}] Auto-skipped ${repo}#${itemNumber} after ${count} timeouts`);
    await countRemoval(jobName, "timeout", currentPodClass() ?? "none");
  } else {
    newTimeoutMs = await escalateTimeout(repo, itemNumber);
    log.info(`[${jobName}] Escalated timeout for ${repo}#${itemNumber} to ${Math.round(newTimeoutMs / 60_000)}min`);
  }

  try {
    await reportTimeoutOnItem(repo, itemNumber, count, error, shouldSkip, newTimeoutMs);
  } catch (commentErr) {
    log.warn(`[${jobName}] Failed to post timeout comment on ${repo}#${itemNumber}: ${commentErr}`);
  }
}
