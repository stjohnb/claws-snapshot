import { compareIssueRefs, type IssueRef } from "./issue-id.js";
import * as gh from "./github.js";
import * as log from "./log.js";

// ── Per-title serialization + recently-created tracking ──
//
// ensureAlertIssue/upsertAlertIssue run find-then-create with no built-in
// serialization. Two concurrent calls for the same repo+title (e.g.
// issue-dispatcher handling several repos at once) can both find nothing and
// both create an issue. These two maps close that race in-process:
//
// - `locks` chains concurrent calls for the same key so only one runs at a
//   time — the second sees the first's newly-created issue.
// - `recentlyCreated` covers a list fetch that was already in flight when the
//   create happened: even serialized, a stale cached `listOpenIssues` result
//   could otherwise still miss the issue just created.

const locks = new Map<string, Promise<void>>();

function lockKey(repo: string, title: string): string {
  return `${repo}\0${title}`;
}

/** Run `fn` after any call already queued for `key` finishes, success or failure. */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, settled);
  void settled.finally(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return result;
}

interface RecentlyCreatedEntry {
  issueNumber: IssueRef;
  createdAt: number;
}

/** Longer than listOpenIssues' 60s cache, so a stale list in flight when the
 *  create happened is always covered by the time its TTL expires. */
const RECENTLY_CREATED_TTL_MS = 2 * 60 * 1000;

const recentlyCreated = new Map<string, RecentlyCreatedEntry>();

function getRecentlyCreated(repo: string, title: string): RecentlyCreatedEntry | null {
  const key = lockKey(repo, title);
  const entry = recentlyCreated.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt >= RECENTLY_CREATED_TTL_MS) {
    recentlyCreated.delete(key);
    return null;
  }
  return entry;
}

function recordRecentlyCreated(repo: string, title: string, issueNumber: IssueRef): void {
  sweepExpiredRecentlyCreated();
  recentlyCreated.set(lockKey(repo, title), { issueNumber, createdAt: Date.now() });
}

/** Opportunistic GC: recentlyCreated has no other eviction path for keys that are never looked up again. */
function sweepExpiredRecentlyCreated(): void {
  const now = Date.now();
  for (const [key, entry] of recentlyCreated) {
    if (now - entry.createdAt >= RECENTLY_CREATED_TTL_MS) recentlyCreated.delete(key);
  }
}

/** Test-only: clear per-title locks and the recently-created map between test cases. */
export function __resetOccurrenceTrackingForTests(): void {
  locks.clear();
  recentlyCreated.clear();
}

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
  supersededMessage?: (keptIssueNumber: IssueRef) => string;
  /**
   * When no issue titled `title` (or a legacy title, or a recently created
   * one) is open, check this against every open issue before filing a new
   * one. On the first match, the alert is skipped — reported as outcome
   * `"covered"` with that issue's number — rather than filing a duplicate of
   * a signal another process already surfaced. Runs over the same cached
   * `gh.listOpenIssues(repo)` result the title lookup already uses, so it
   * costs no extra API call.
   */
  coveredBy?: (issue: gh.Issue) => boolean;
}

export type EnsureAlertIssueOutcome = "created" | "updated" | "tracking-not-updated" | "covered";

export interface EnsureAlertIssueResult {
  outcome: EnsureAlertIssueOutcome;
  issueNumber: IssueRef;
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
  keptIssueNumber: IssueRef,
  duplicates: { number: IssueRef; title: string }[],
): Promise<void> {
  const supersededMessage =
    opts.supersededMessage ?? ((n: IssueRef) => `Superseded by #${n}.`);

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
): Promise<{ number: IssueRef; title: string } | null> {
  const open = await gh.listOpenIssues(opts.repo);

  const legacySet = new Set(legacyTitles);
  const legacyMatches = open.filter((i) => legacySet.has(i.title)).sort((a, b) => compareIssueRefs(a.number, b.number));

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

export function ensureAlertIssue(opts: EnsureAlertIssueOptions): Promise<EnsureAlertIssueResult> {
  return withLock(lockKey(opts.repo, opts.title), () => ensureAlertIssueLocked(opts));
}

async function ensureAlertIssueLocked(opts: EnsureAlertIssueOptions): Promise<EnsureAlertIssueResult> {
  const timestamp = opts.timestamp ?? new Date().toISOString();
  let existing: { number: IssueRef; title: string } | null = opts.legacyTitles?.length
    ? await findExistingWithLegacyTitles(opts, opts.legacyTitles)
    : await gh.findIssueByExactTitle(opts.repo, opts.title);

  if (!existing) {
    // Trades a narrow window for correctness: if the issue was closed within the TTL
    // by something other than this process, this can still resurrect it via editIssue
    // below rather than filing a new one.
    const recent = getRecentlyCreated(opts.repo, opts.title);
    if (recent) existing = { number: recent.issueNumber, title: opts.title };
  }

  if (!existing && opts.coveredBy) {
    const open = await gh.listOpenIssues(opts.repo);
    const covering = open.find(opts.coveredBy);
    if (covering) {
      log.info(`[${opts.logPrefix}] "${opts.title}" covered by open #${covering.number} — not filing`);
      return { outcome: "covered", issueNumber: covering.number };
    }
  }

  if (!existing) {
    const issueNumber = await gh.createIssue(
      opts.repo,
      opts.title,
      appendOccurrenceTracking(opts.body, timestamp),
      opts.labels ?? [],
    );
    recordRecentlyCreated(opts.repo, opts.title, issueNumber);
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
): Promise<IssueRef | null> {
  const existing = await gh.findIssueByExactTitle(opts.repo, opts.title);
  if (!existing) return null;
  await gh.closeIssue(opts.repo, existing.number, "completed");
  log.info(
    `[${opts.logPrefix}] ${opts.repo}${opts.reason ? `: ${opts.reason}` : ""} — closed #${existing.number}`,
  );
  return existing.number;
}

export interface UpsertAlertIssueOptions {
  repo: string;
  title: string;
  body: string;
  labels: string[];
  logPrefix: string;
  /** Extra context appended to the "Created alert issue" log line, e.g. "3 device(s) low". */
  createdDetail?: string;
}

export type UpsertAlertIssueResult = "created" | "updated" | "unchanged";

/**
 * Find-or-create an alert issue by exact title, editing the body only when it
 * actually changed. Deliberately NOT ensureAlertIssue(): that helper stamps an
 * occurrence timestamp into the body, which forces an editIssue on every tick.
 * Callers whose body is a pure function of current state want the no-op path
 * instead, so a persistent alert costs one listOpenIssues + one getIssueBody
 * per tick and nothing else.
 */
export function upsertAlertIssue(
  opts: UpsertAlertIssueOptions,
): Promise<UpsertAlertIssueResult> {
  return withLock(lockKey(opts.repo, opts.title), () => upsertAlertIssueLocked(opts));
}

async function upsertAlertIssueLocked(
  opts: UpsertAlertIssueOptions,
): Promise<UpsertAlertIssueResult> {
  const { repo, title, body, labels, logPrefix, createdDetail } = opts;
  let existing: { number: IssueRef } | null = await gh.findIssueByExactTitle(repo, title);
  if (!existing) {
    const recent = getRecentlyCreated(repo, title);
    if (recent) existing = { number: recent.issueNumber };
  }
  if (!existing) {
    const issueNumber = await gh.createIssue(repo, title, body, labels);
    recordRecentlyCreated(repo, title, issueNumber);
    log.info(`[${logPrefix}] Created alert issue in ${repo}: ${title}${createdDetail ? ` — ${createdDetail}` : ""}`);
    return "created";
  }
  const currentBody = (await gh.getIssueBody(repo, existing.number)) ?? "";
  if (body === currentBody) {
    log.debug(`[${logPrefix}] Alert issue #${existing.number} body unchanged — skipping edit`);
    return "unchanged";
  }
  await gh.editIssue(repo, existing.number, body);
  log.info(`[${logPrefix}] Updated alert issue #${existing.number} in ${repo}`);
  return "updated";
}
