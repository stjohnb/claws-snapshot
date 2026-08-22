import * as gh from "./github.js";
import * as log from "./log.js";

export function appendOccurrenceTracking(body: string, timestamp: string, initialCount = 1): string {
  const parts = body ? [body, "", "---"] : ["---"];
  return [
    ...parts,
    `**First seen:** ${timestamp}`,
    `**Last seen:** ${timestamp}`,
    `**Occurrences:** ${initialCount}`,
  ].join("\n");
}

export function updateOccurrenceTracking(body: string, timestamp: string): string {
  return body.replace(
    /\*\*First seen:\*\* (.+)\n\*\*Last seen:\*\* .+\n\*\*Occurrences:\*\* (\d+)$/,
    (_, firstSeen, count) =>
      [
        `**First seen:** ${firstSeen}`,
        `**Last seen:** ${timestamp}`,
        `**Occurrences:** ${parseInt(count, 10) + 1}`,
      ].join("\n"),
  );
}

export function parseOccurrenceCount(body: string): number | null {
  const m = body.match(/\*\*Occurrences:\*\* (\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export function parseFirstSeen(body: string): string | null {
  const m = body.match(/\*\*First seen:\*\* (.+)/);
  return m ? m[1].trim() : null;
}

/**
 * Rebuild an alert issue body from scratch, carrying the occurrence-tracking
 * state forward. Unlike updateOccurrenceTracking (which patches the tracking
 * block in place and leaves the prose alone), this replaces the whole body with
 * `newBody` — used by callers whose alert body describes the *current* state of
 * a resource that can change between runs (e.g. a k3s workload transitioning
 * from Failed to CrashLoopBackOff), so a stale reason must not linger.
 *
 * First seen is preserved when present; Occurrences increments (defaulting to 1
 * when absent, so a body with no tracking block becomes 2 — the caller has just
 * observed a recurrence).
 */
export function rebuildOccurrenceTracking(newBody: string, currentBody: string, timestamp: string): string {
  const firstSeen = parseFirstSeen(currentBody) ?? timestamp;
  const count = parseOccurrenceCount(currentBody) ?? 1;
  const parts = newBody ? [newBody, "", "---"] : ["---"];
  return [
    ...parts,
    `**First seen:** ${firstSeen}`,
    `**Last seen:** ${timestamp}`,
    `**Occurrences:** ${count + 1}`,
  ].join("\n");
}

export function applyOccurrenceTracking(
  currentBody: string,
  timestamp: string,
): { updatedBody: string; matched: boolean } {
  if (currentBody.includes("**First seen:**")) {
    const updated = updateOccurrenceTracking(currentBody, timestamp);
    return { updatedBody: updated, matched: updated !== currentBody };
  }
  // Retroactive — assume at least the 2nd occurrence (caller has just observed a recurrence)
  return { updatedBody: appendOccurrenceTracking(currentBody, timestamp, 2), matched: true };
}

export interface EnsureAlertIssueOptions {
  repo: string;
  title: string;
  body: string;
  labels?: string[];
  timestamp?: string;
  logPrefix: string;
  /**
   * Older titles that identify the same alert. When one matches and no issue
   * titled `title` is open, that issue is renamed to `title` rather than a new
   * issue being filed — so changing an alert's title scheme does not fork a
   * second issue for an incident that is already tracked. Extra matches beyond
   * the lowest-numbered one are closed as superseded.
   */
  legacyTitles?: string[];
  /**
   * Replace the whole issue body with `body` on update, preserving First seen
   * and incrementing Occurrences. Use when the body describes state that can
   * change between runs; note it discards any hand-edited prose in the body
   * (comments are untouched).
   */
  refreshBody?: boolean;
  /**
   * Comment posted on a legacy-titled issue that gets closed as a duplicate
   * once its title match is superseded by `opts.title`. Defaults to a
   * domain-agnostic message; callers with a more specific story (e.g. what
   * kind of alert is being consolidated) can override it.
   */
  supersededMessage?: (keptIssueNumber: number) => string;
}

export type EnsureAlertIssueOutcome = "created" | "updated" | "tracking-not-updated";

export interface EnsureAlertIssueResult {
  outcome: EnsureAlertIssueOutcome;
  issueNumber: number;
}

/**
 * Resolve the open issue tracking this alert, migrating a legacy-titled issue
 * onto `opts.title` when one exists. Uses a single cached `listOpenIssues` call
 * rather than one `gh search issues` per legacy title — searches are capped at
 * 30/min and a caller can pass a legacy list per resource per run.
 */
/**
 * Close each of `duplicates` as superseded by `keptIssueNumber`. Best-effort —
 * losing a single duplicate close must never abort the alert, so failures are
 * logged and left for the next run to retry.
 */
async function closeSupersededDuplicates(
  opts: EnsureAlertIssueOptions,
  keptIssueNumber: number,
  duplicates: { number: number; title: string }[],
): Promise<void> {
  const supersededMessage =
    opts.supersededMessage ?? ((n: number) => `Superseded by #${n}.`);

  for (const dup of duplicates) {
    try {
      await gh.commentOnIssue(opts.repo, dup.number, supersededMessage(keptIssueNumber));
      await gh.closeIssue(opts.repo, dup.number, "not_planned");
      log.info(`[${opts.logPrefix}] Closed #${dup.number} as superseded by #${keptIssueNumber}`);
    } catch (err) {
      log.warn(`[${opts.logPrefix}] Failed to close superseded issue #${dup.number}: ${err}`);
    }
  }
}

async function findExistingWithLegacyTitles(
  opts: EnsureAlertIssueOptions,
  legacyTitles: string[],
): Promise<{ number: number; title: string } | null> {
  const open = await gh.listOpenIssues(opts.repo);

  const legacySet = new Set(legacyTitles);
  const legacyMatches = open.filter((i) => legacySet.has(i.title)).sort((a, b) => a.number - b.number);

  const current = open.find((i) => i.title === opts.title);
  if (current) {
    // Re-scan for stray legacy-titled duplicates on every call (not just the
    // migration run) so a duplicate left open by a prior failed closeIssue
    // gets retried instead of lingering forever.
    if (legacyMatches.length > 0) await closeSupersededDuplicates(opts, current.number, legacyMatches);
    return { number: current.number, title: current.title };
  }

  if (legacyMatches.length === 0) return null;

  const [kept, ...superseded] = legacyMatches;
  await gh.editIssueTitle(opts.repo, kept.number, opts.title);
  log.info(`[${opts.logPrefix}] Renamed #${kept.number} "${kept.title}" → "${opts.title}"`);
  await closeSupersededDuplicates(opts, kept.number, superseded);

  return { number: kept.number, title: opts.title };
}

export async function ensureAlertIssue(opts: EnsureAlertIssueOptions): Promise<EnsureAlertIssueResult> {
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const existing = opts.legacyTitles?.length
    ? await findExistingWithLegacyTitles(opts, opts.legacyTitles)
    : await gh.findIssueByExactTitle(opts.repo, opts.title);

  if (!existing) {
    const issueNumber = await gh.createIssue(
      opts.repo,
      opts.title,
      appendOccurrenceTracking(opts.body, timestamp),
      opts.labels ?? [],
    );
    return { outcome: "created", issueNumber };
  }

  const currentBody = (await gh.getIssueBody(opts.repo, existing.number)) ?? "";
  const { updatedBody, matched } = opts.refreshBody
    ? { updatedBody: rebuildOccurrenceTracking(opts.body, currentBody, timestamp), matched: true }
    : applyOccurrenceTracking(currentBody, timestamp);
  if (!matched) {
    log.warn(`[${opts.logPrefix}] Could not update occurrence tracking for "${opts.title}"`);
    return { outcome: "tracking-not-updated", issueNumber: existing.number };
  }
  await gh.editIssue(opts.repo, existing.number, updatedBody);
  return { outcome: "updated", issueNumber: existing.number };
}

export interface CloseAlertIssueOptions {
  repo: string;
  title: string;
  /** Job name used as the `[prefix]` in log lines — same value as ensureAlertIssue's logPrefix. */
  logPrefix: string;
  /** Short phrase describing why the alert cleared, e.g. "no open alerts". Appended to the log line. */
  reason?: string;
}

/**
 * Close-when-resolved half of the alert-issue lifecycle (the counterpart to
 * ensureAlertIssue). Returns the number of the issue it closed, or null when
 * no matching open issue exists. Errors propagate — every current call site
 * already wraps its GitHub work in try/catch.
 */
export async function closeAlertIssueIfResolved(
  opts: CloseAlertIssueOptions,
): Promise<number | null> {
  const existing = await gh.findIssueByExactTitle(opts.repo, opts.title);
  if (!existing) return null;
  await gh.closeIssue(opts.repo, existing.number, "completed");
  log.info(
    `[${opts.logPrefix}] ${opts.repo}${opts.reason ? `: ${opts.reason}` : ""} — closed #${existing.number}`,
  );
  return existing.number;
}
