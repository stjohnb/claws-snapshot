/**
 * The file-overlap gate (#clw_01M7WDMJ9GCF6MCZ0BPKN3333S): which in-flight
 * work in a repo edits the same files, derived from the database on each use
 * and never stored. `loadInFlight` builds a repo's in-flight steps from its
 * open, issue-linked `claws_prs` rows and their cached changed files
 * (`claws_pr_files`), plus the approved plan steps whose PR has not opened yet
 * and their declared `paths` (`claws_issue_prs`); `conflictDeferral` tells
 * the CI fixer whether a conflicting PR should wait for an overlapping PR
 * ahead of it to merge rather than have its conflicts resolved now;
 * `overlapsForIssue` lists, per plan step of one issue, the steps that hold it
 * and the steps it holds, for the issue page, `claws_get_issue` and the
 * planner's prompt; `heldSteps` tells the dispatcher and the implementer
 * which of an issue's ready steps wait on overlapping work ahead of them, and
 * `storedOverlapHolds` tells the board, from stored rows alone, which issues
 * wait with every ready step held; `liftOverlapHold` is Start anyway.
 *
 * Only running work (an open PR, or a ready step of an issue with an active
 * implementer job) or a step that can start now holds
 * (#clw_01M80QPKHGF99SNVZE66C46TY2): a step whose dependencies have not
 * landed, or that is itself held, holds nothing, and shared Markdown docs
 * never hold — `planStepFootprints` lists them as an expected rebase.
 * Nothing holds when the repo's `overlap.enabled` is false. An open PR with no
 * cached file list for its head falls back to its step's declared paths, or
 * holds nothing and is never held when there are none (Decision 6); a failed
 * read never holds work. See `overlap.ts` for the matching, order, give-way
 * and holding rules.
 */

import * as db from "./db.js";
import * as gh from "./github.js";
import { getRepoConfig } from "./repo-config.js";
import * as log from "./log.js";
import { mapSettledWithConcurrency } from "./util.js";
import { atLeast } from "./issue-approval.js";
import { finishCoverage, parsePhaseClaims } from "./phase-coverage.js";
import { compareInFlightSteps, filterIgnoredPaths, formatSharedPaths, givesWay, holdersAhead, resolveHolding, sharedDocPaths, type InFlightStep } from "./overlap.js";

/** How long a repo's in-flight steps are reused before the database is read again. */
export const IN_FLIGHT_MEMO_MS = 60_000;
/** How many issues {@link storedOverlapHolds} and {@link loadInFlight}'s readiness read reads at once. */
const STORED_HOLDS_CONCURRENCY = 8;

const memo = new Map<string, { at: number; steps: InFlightStep[] }>();

/** Whether file-overlap sequencing is on for `repo` (its `claws.json` `overlap.enabled`; on when unset or unread). */
export function overlapEnabled(repo: string): boolean {
  return getRepoConfig(repo)?.overlap?.enabled !== false;
}

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The tracker ids of the issues with an implementer job active
 * (`db.listActiveImplementerRefs`): a `clw_…` item (any string ref) is the
 * id, a forge number goes through `db.getLinkedNativeId`.
 */
async function activeImplementerIssueIds(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ref of await db.listActiveImplementerRefs()) {
    if (typeof ref.itemNumber === "string") out.add(ref.itemNumber);
    else {
      const id = await db.getLinkedNativeId(ref.repo, ref.itemNumber);
      if (id) out.add(id);
    }
  }
  return out;
}

/**
 * The ready positions of each of `issueIds` ({@link storedReadySteps}),
 * keyed by issue; an issue whose read fails, or whose record is missing, has
 * none, so its steps never hold work.
 */
async function readyPositionsByIssue(issueIds: string[]): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>();
  const results = await mapSettledWithConcurrency(issueIds, STORED_HOLDS_CONCURRENCY, async (id): Promise<number[]> => {
    const record = await db.getClawsIssue(id);
    return record ? (await storedReadySteps(record)).map((e) => e.position) : [];
  });
  results.forEach((result, i) => {
    const id = issueIds[i]!;
    if (result.status === "fulfilled") out.set(id, new Set(result.value));
    else log.warn("overlap_readiness_read_failed", { component: "overlap-gate", issue: id }, result.reason);
  });
  return out;
}

/**
 * `repo`'s in-flight steps: one per open `claws_prs` row linked to an issue,
 * its paths the row's cached changed files after the repo's ignore list (the
 * step's declared paths when no list is cached for its head, else none), and
 * marked as giving way when its PR is stalled, its issue is Blocked or in
 * Backlog, or it opened over 48 hours ago; then one per unstarted plan step
 * with declared paths (`db.listOverlapUnstartedSteps`) that no
 * trusted `claws-phase-done:` claim covers, giving way 48 hours after its Plan
 * approval. An open PR's step is running; an unstarted step is ready when
 * every step it depends on is done ({@link storedReadySteps}; not ready when
 * that read fails), running when ready and its issue has an active
 * implementer job, and exempt when its issue is Priority or lifted. Then
 * {@link resolveHolding} settles which steps hold, so only running or
 * startable steps do (#clw_01M80QPKHGF99SNVZE66C46TY2). Empty when the repo's
 * switch is off. Reused for {@link IN_FLIGHT_MEMO_MS}.
 */
export async function loadInFlight(repo: string, nowMs = Date.now()): Promise<InFlightStep[]> {
  if (!overlapEnabled(repo)) return [];
  const cached = memo.get(repo);
  if (cached && nowMs - cached.at < IN_FLIGHT_MEMO_MS) return cached.steps;
  const ignore = getRepoConfig(repo)?.overlap?.ignorePaths ?? [];
  const rows = await db.listOverlapPrRows(repo);
  const steps = rows.map((row): InFlightStep => {
    const planApprovedAtMs = parseMs(row.planApprovedAt);
    const priority = gh.hasPriorityLabel(row.issueLabels.map((name) => ({ name })));
    return {
      issueId: row.issueId,
      position: row.phase,
      prNumber: row.prNumber,
      hasOpenPr: true,
      running: true,
      ready: true,
      exempt: priority,
      priority,
      planApprovedAtMs,
      paths: filterIgnoredPaths(row.files ?? row.declaredPaths ?? [], ignore),
      holds: !givesWay({
        stalled: row.stage === "problematic" || !!row.ciBlockedReason,
        lifecycle: row.lifecycle,
        inFlightSinceMs: parseMs(row.createdAt) ?? planApprovedAtMs,
        nowMs,
      }),
    };
  });
  const unstarted: db.OverlapUnstartedStep[] = [];
  for (const row of await db.listOverlapUnstartedSteps(repo)) {
    const claimed = await parsePhaseClaims(row.claimComments, (login) => gh.isAllowedActor(login, repo, row.issueId), row.totalSteps);
    if (!claimed.has(row.position)) unstarted.push(row);
  }
  if (unstarted.length > 0) {
    const active = await activeImplementerIssueIds();
    const ready = await readyPositionsByIssue([...new Set(unstarted.map((row) => row.issueId))]);
    for (const row of unstarted) {
      const planApprovedAtMs = parseMs(row.planApprovedAt);
      const priority = gh.hasPriorityLabel(row.issueLabels.map((name) => ({ name })));
      const isReady = ready.get(row.issueId)?.has(row.position) ?? false;
      steps.push({
        issueId: row.issueId,
        position: row.position,
        prNumber: null,
        hasOpenPr: false,
        running: isReady && active.has(row.issueId),
        ready: isReady,
        exempt: priority || row.holdLifted,
        priority,
        planApprovedAtMs,
        paths: filterIgnoredPaths(row.paths, ignore),
        holds: !givesWay({ stalled: false, lifecycle: row.lifecycle, inFlightSinceMs: planApprovedAtMs, nowMs }),
      });
    }
  }
  const resolved = resolveHolding(steps);
  memo.set(repo, { at: nowMs, steps: resolved });
  return resolved;
}

/** Another step an issue's step overlaps with: who it is and the paths both touch. */
export interface OverlapLink {
  issueId: string;
  /** The plan position; null when unknown. */
  position: number | null;
  /** The step's open PR, or null for a step not started yet. */
  prNumber: number | null;
  /** The step is running: an open PR, or an active implementer job on its issue. */
  running: boolean;
  shared: string[];
}

/** One plan step of an issue and the in-flight steps it overlaps with. */
export interface StepOverlaps {
  repo: string;
  position: number;
  /** The steps ahead of this one that hold it. */
  heldBy: OverlapLink[];
  /** The steps behind this one that it holds. */
  holds: OverlapLink[];
}

function linkOf(step: InFlightStep, shared: string[]): OverlapLink {
  return { issueId: step.issueId, position: step.position, prNumber: step.prNumber, running: step.running, shared };
}

/**
 * Per `pr` step of `trackerId`'s stored plan with paths, the other issues'
 * in-flight steps in its repo that hold it and those it holds; a step with
 * neither is left out. The issue's own steps are never listed: `depends_on`
 * already orders them.
 * A step already in flight is matched as itself; one not in flight (the issue
 * is not approved yet, or the step waits on a dependency) is placed in the
 * order as it would be if it started now, with its declared paths, so the
 * planner and the operator see overlaps at plan time. A step whose PR is
 * linked but no longer open (merged or closed) has none. Empty for a closed
 * issue, and for each repo whose switch is off.
 */
export async function overlapsForIssue(trackerId: string, nowMs = Date.now()): Promise<StepOverlaps[]> {
  const issue = await db.getClawsIssue(trackerId);
  if (!issue || issue.state !== "open") return [];
  const planned = (await db.getIssuePlannedPRs(trackerId)).filter((e) => e.kind === "pr");
  const out: StepOverlaps[] = [];
  const byRepo = new Map<string, InFlightStep[]>();
  for (const entry of planned) {
    if (!overlapEnabled(entry.repo)) continue;
    let inFlight = byRepo.get(entry.repo);
    if (!inFlight) {
      inFlight = await loadInFlight(entry.repo, nowMs);
      byRepo.set(entry.repo, inFlight);
    }
    let self = inFlight.find((s) => s.issueId === trackerId && s.position === entry.position);
    if (!self) {
      if (entry.prNumber !== null || !entry.paths || entry.paths.length === 0) continue;
      const ignore = getRepoConfig(entry.repo)?.overlap?.ignorePaths ?? [];
      self = {
        issueId: trackerId,
        position: entry.position,
        prNumber: null,
        hasOpenPr: false,
        running: false,
        ready: true,
        exempt: false,
        priority: gh.hasPriorityLabel(issue.labels.map((name) => ({ name }))),
        planApprovedAtMs: parseMs(issue.plan_approved_at ?? null),
        paths: filterIgnoredPaths(entry.paths, ignore),
        holds: true,
      };
    }
    const heldBy = holdersAhead(self, inFlight).filter((h) => h.step.issueId !== trackerId).map((h) => linkOf(h.step, h.shared));
    const holds: OverlapLink[] = [];
    if (self.holds) {
      const others = inFlight.filter((s) => s.issueId !== trackerId && s.ready && compareInFlightSteps(self, s) < 0);
      for (const other of others) {
        const hit = holdersAhead(other, [...inFlight.filter((s) => s !== self), self]).find((h) => h.step === self);
        if (hit) holds.push(linkOf(other, hit.shared));
      }
    }
    if (heldBy.length > 0 || holds.length > 0) out.push({ repo: entry.repo, position: entry.position, heldBy, holds });
  }
  return out;
}

/** The open PR a conflicting PR waits on, and the paths both change. */
export interface ConflictDeferral {
  waitsOn: number;
  issueId: string;
  files: string[];
}

/**
 * The open PR ahead of `repo#prNumber` that changes the same files, which
 * should merge before `prNumber`'s merge conflicts are resolved; null when
 * none holds it (the front PR, a PR with neither a cached file list nor
 * declared paths for its step, a repo with the switch off). A PR with no cached
 * file list is matched by its step's declared paths. The caller exempts a Priority PR.
 */
export async function conflictDeferral(repo: string, prNumber: number, nowMs = Date.now()): Promise<ConflictDeferral | null> {
  const steps = await loadInFlight(repo, nowMs);
  const self = steps.find((s) => s.prNumber === prNumber);
  if (!self) return null;
  const holder = holdersAhead(self, steps).find((h) => h.step.prNumber !== null);
  if (!holder || holder.step.prNumber === null) return null;
  return { waitsOn: holder.step.prNumber, issueId: holder.step.issueId, files: holder.shared };
}

/** Exposed for tests. */
export function clearInFlightMemo(): void {
  memo.clear();
}

/** One `pr` step of an issue's stored plan, with its footprint and overlaps — the issue page's Plan steps and `claws_get_issue`. */
export interface PlanStepFootprint {
  position: number;
  repo: string;
  title: string;
  /** The declared paths; empty when the planner declared none. */
  paths: string[];
  prNumber: number | null;
  /** How many files the step's PR changes at its current head; null when not cached or no PR. */
  changedFiles: number | null;
  heldBy: OverlapLink[];
  holds: OverlapLink[];
  /**
   * The shared Markdown docs the step changes that another issue's running or
   * ready step also changes: they never hold, but expect a rebase. Sorted and
   * deduplicated; empty for a closed issue or a repo with the switch off.
   */
  expectedRebase: string[];
}

/**
 * The shared Markdown docs (`isSharedDocPath`) `trackerId`'s step at
 * `entry`'s repo and position shares with any other issue's in-flight step
 * that is running or ready. The step's paths are its in-flight paths (its
 * PR's changed files) when it is in flight, else its declared paths; a step
 * whose PR is no longer open has none.
 */
async function expectedRebaseFor(trackerId: string, entry: db.IssuePlannedPR, nowMs: number): Promise<string[]> {
  if (!overlapEnabled(entry.repo)) return [];
  const inFlight = await loadInFlight(entry.repo, nowMs);
  const self = inFlight.find((s) => s.issueId === trackerId && s.position === entry.position);
  let paths: readonly string[];
  if (self) paths = self.paths;
  else if (entry.prNumber === null && entry.paths) paths = filterIgnoredPaths(entry.paths, getRepoConfig(entry.repo)?.overlap?.ignorePaths ?? []);
  else return [];
  const out = new Set<string>();
  for (const other of inFlight) {
    if (other.issueId === trackerId || !(other.running || other.ready)) continue;
    for (const p of sharedDocPaths(other.paths, paths)) out.add(p);
  }
  return [...out].sort();
}

/**
 * Every `pr` step of `trackerId`'s stored plan with its declared paths, its
 * PR's cached changed-file count, {@link overlapsForIssue}'s overlaps and its
 * expected rebases. Reads the database only.
 */
export async function planStepFootprints(trackerId: string, nowMs = Date.now()): Promise<PlanStepFootprint[]> {
  const planned = (await db.getIssuePlannedPRs(trackerId)).filter((e) => e.kind === "pr");
  if (planned.length === 0) return [];
  const overlaps = await overlapsForIssue(trackerId, nowMs);
  const open = (await db.getClawsIssue(trackerId))?.state === "open";
  const out: PlanStepFootprint[] = [];
  for (const entry of planned) {
    let changedFiles: number | null = null;
    if (entry.prNumber !== null) {
      const pr = await db.getClawsPr(entry.repo, entry.prNumber);
      const files = pr?.headSha ? await db.getClawsPrFiles(entry.repo, entry.prNumber, pr.headSha) : null;
      changedFiles = files ? files.length : null;
    }
    const hit = overlaps.find((o) => o.repo === entry.repo && o.position === entry.position);
    out.push({
      position: entry.position,
      repo: entry.repo,
      title: entry.title,
      paths: entry.paths ?? [],
      prNumber: entry.prNumber,
      changedFiles,
      heldBy: hit?.heldBy ?? [],
      holds: hit?.holds ?? [],
      expectedRebase: open ? await expectedRebaseFor(trackerId, entry, nowMs) : [],
    });
  }
  return out;
}

/** A plan step the implementer could start now, as {@link heldSteps} reads it; an `IssuePlannedPR` satisfies it. */
export interface ReadyStep {
  position: number;
  repo: string;
  /** The declared paths; a step with none is never held. */
  paths?: readonly string[] | null;
}

/** Why a ready step waits: the in-flight steps ahead of it in its repo that change the same files, front first. */
export interface OverlapHold {
  repo: string;
  position: number;
  holders: OverlapLink[];
}

/** The issue {@link heldSteps} decides for: its tracker id (null holds nothing) and whether it is Priority. */
export interface OverlapIssue {
  id: string | null;
  priority: boolean;
  /** The issue's record when the caller already holds it, so it is not read again. */
  record?: db.ClawsIssueRecord;
}

/**
 * Per position of `readySteps`, the hold on it, or null when it may start:
 * the steps ahead of it in {@link compareInFlightSteps}'s order, in its repo,
 * that still hold and share a path with it — another issue's or an earlier
 * step of the same issue. Every step is null for a Priority issue, an issue
 * whose hold was lifted (Start anyway, until it closes), a closed or unknown
 * issue; a step is null when it declares no paths or its repo's switch is off.
 * A step not in the in-flight set (pending re-approval, say) is placed in the
 * order as it would be if it started now. Reads the database only.
 */
export async function heldSteps(
  issue: OverlapIssue,
  readySteps: readonly ReadyStep[],
  nowMs = Date.now(),
): Promise<Map<number, OverlapHold | null>> {
  const out = new Map<number, OverlapHold | null>(readySteps.map((s) => [s.position, null]));
  if (!issue.id || issue.priority || readySteps.length === 0) return out;
  const record = issue.record ?? await db.getClawsIssue(issue.id);
  if (!record || record.state !== "open" || record.overlap_hold_lifted_at) return out;
  if (gh.hasPriorityLabel(record.labels.map((name) => ({ name })))) return out;
  const byRepo = new Map<string, InFlightStep[]>();
  for (const step of readySteps) {
    if (!step.paths || step.paths.length === 0 || !overlapEnabled(step.repo)) continue;
    let inFlight = byRepo.get(step.repo);
    if (!inFlight) {
      inFlight = await loadInFlight(step.repo, nowMs);
      byRepo.set(step.repo, inFlight);
    }
    const self = inFlight.find((s) => s.issueId === issue.id && s.position === step.position && s.prNumber === null) ?? {
      issueId: issue.id,
      position: step.position,
      prNumber: null,
      hasOpenPr: false,
      running: false,
      ready: true,
      exempt: false,
      priority: false,
      planApprovedAtMs: parseMs(record.plan_approved_at ?? null),
      paths: filterIgnoredPaths(step.paths, getRepoConfig(step.repo)?.overlap?.ignorePaths ?? []),
      holds: true,
    };
    const holders = holdersAhead(self, inFlight);
    if (holders.length > 0) out.set(step.position, { repo: step.repo, position: step.position, holders: holders.map((h) => linkOf(h.step, h.shared)) });
  }
  return out;
}

/**
 * The hold on `issue` when every one of `readySteps` is held — the first
 * held step's, to show — or null when any may start, or there are none.
 */
export async function overlapHoldForIssue(issue: OverlapIssue, readySteps: readonly ReadyStep[], nowMs = Date.now()): Promise<OverlapHold | null> {
  if (readySteps.length === 0) return null;
  const held = await heldSteps(issue, readySteps, nowMs);
  let first: OverlapHold | null = null;
  for (const step of readySteps) {
    const hold = held.get(step.position) ?? null;
    if (!hold) return null;
    first ??= hold;
  }
  return first;
}

/**
 * The line a held step shows on its queued item, board card and Stops at:
 * `Waiting on #clw_… step N (owner/repo#PR): shares a, b, c and N more`, naming
 * the front holder; `(owner/repo, implementing)` when it has no PR yet but its
 * implementer is active, `(owner/repo, not started)` otherwise.
 */
export function overlapHoldNote(hold: OverlapHold): string {
  const front = hold.holders[0];
  if (!front) return "Waiting on overlapping work";
  const step = front.position !== null ? ` step ${front.position}` : "";
  const where = front.prNumber !== null ? `${hold.repo}#${front.prNumber}` : `${hold.repo}, ${front.running ? "implementing" : "not started"}`;
  return `Waiting on #${front.issueId}${step} (${where}): shares ${formatSharedPaths(front.shared, 3)}`;
}

/** One `info` line per held item, as the CI queue gate logs its holds. */
export function logOverlapHold(issueRepo: string, kind: string, item: string | number, hold: OverlapHold): void {
  const front = hold.holders[0];
  log.info("overlap_hold", {
    component: "overlap-gate",
    repo: hold.repo,
    issue_repo: issueRepo,
    kind,
    item: String(item),
    step: hold.position,
    waits_on: front ? front.issueId : null,
    waits_on_step: front?.position ?? null,
    waits_on_pr: front?.prNumber ?? null,
    files: front ? front.shared.slice(0, 20) : [],
  });
}

/**
 * The `pr` steps of `record`'s stored plan that are ready, read from stored
 * rows and claims only (no forge read): a step is covered by a `claws_prs` row
 * at its repo and position (or its linked PR) that is not closed, or by a
 * trusted `claws-phase-done:` claim, and done once that row merged or the
 * claim names it; it is ready when uncovered and every step it depends on is
 * done. A linked PR with no row counts as covered, not done.
 */
async function storedReadySteps(record: db.ClawsIssueRecord, planned?: readonly db.IssuePlannedPR[]): Promise<db.IssuePlannedPR[]> {
  const entries = planned ?? await db.getIssuePlannedPRs(record.id);
  if (entries.length === 0) return [];
  const rows = await db.listClawsPrsForIssue(record.id);
  const comments = await db.listClawsIssueComments(record.id);
  const repo = record.repos[0] ?? entries[0].repo;
  const claimed = await parsePhaseClaims(
    comments.filter((c) => c.body.includes("claws-phase-done:")).map((c) => ({ body: c.body, login: c.author_login })),
    (login) => gh.isAllowedActor(login, repo, record.id),
    entries.length,
  );
  const covered = new Set<number>(claimed);
  const done = new Set<number>(claimed);
  for (const entry of entries) {
    const mine = rows.filter((r) => r.repo === entry.repo && r.stage !== "closed"
      && (r.phase === entry.position || (entry.prNumber !== null && r.prNumber === entry.prNumber)));
    if (mine.some((r) => r.stage === "merged")) {
      covered.add(entry.position);
      done.add(entry.position);
    } else if (mine.length > 0) {
      covered.add(entry.position);
    } else if (entry.prNumber !== null && !rows.some((r) => r.repo === entry.repo && r.prNumber === entry.prNumber)) {
      covered.add(entry.position);
    }
  }
  const total = Math.max(...entries.map((e) => e.position));
  const dependsOn = Array.from({ length: total }, (_, i) => entries.find((e) => e.position === i + 1)?.dependsOn ?? null);
  const manual = new Set(entries.filter((e) => e.kind === "manual").map((e) => e.position));
  const { readyPhases } = finishCoverage(total, covered, done, done, dependsOn, manual);
  return readyPhases.flatMap((n) => entries.filter((e) => e.position === n && e.kind === "pr"));
}

/**
 * Of `records`, the open native issues approved through Plan (lifecycle
 * `awaiting-plan-review`, so neither Blocked nor in the Backlog) whose every
 * ready step, read from stored rows and claims ({@link storedReadySteps}), is
 * held, mapped to the hold to show. For the board's Queued column, the issue
 * page and `claws_get_issue` / `claws_list_issues`; the dispatcher decides
 * from live coverage instead, so the two can differ for a tick. Best-effort:
 * a failure is logged and leaves that issue out.
 */
export async function storedOverlapHolds(records: readonly db.ClawsIssueRecord[], nowMs = Date.now()): Promise<Map<string, OverlapHold>> {
  const out = new Map<string, OverlapHold>();
  const candidates = records.filter((record) => record.kind === "issue" && record.state === "open" && record.lifecycle === "awaiting-plan-review"
    && atLeast(record.approved_through ?? "none", "plan") && !record.overlap_hold_lifted_at
    && record.repos.some(overlapEnabled) && !gh.hasPriorityLabel(record.labels.map((name) => ({ name }))));
  if (candidates.length === 0) return out;
  // Warm the per-repo in-flight memo once, so the concurrent reads below share it.
  for (const repo of new Set(candidates.flatMap((record) => record.repos.filter(overlapEnabled)))) {
    await loadInFlight(repo, nowMs).catch(() => undefined);
  }
  const results = await mapSettledWithConcurrency(candidates, STORED_HOLDS_CONCURRENCY, async (record) => {
    const ready = await storedReadySteps(record);
    return overlapHoldForIssue({ id: record.id, priority: false, record }, ready, nowMs);
  });
  results.forEach((result, i) => {
    const id = candidates[i]!.id;
    if (result.status === "rejected") log.warn("overlap_hold_read_failed", { component: "overlap-gate", issue: id }, result.reason);
    else if (result.value) out.set(id, result.value);
  });
  return out;
}

/** An issue's current overlap holds, as {@link storedIssueHolds} reads them. */
export interface StoredIssueHolds {
  /** How many entries the issue's stored plan has (every kind); 0 for an unknown issue. */
  plannedCount: number;
  /** Each ready step that is held, with the steps holding it; empty when nothing is held. */
  holds: OverlapHold[];
}

/**
 * `trackerId`'s ready steps that are held now, from the same stored rows the
 * board's Queued column reads ({@link storedReadySteps}, {@link heldSteps}): a
 * step with an open PR is never ready, so never held, and a closed, lifted
 * (Start anyway) or Priority issue holds nothing. Unlike
 * {@link storedOverlapHolds} a partly held issue lists its held steps. Also
 * returns the stored plan's size, read once, so the caller need not read it again.
 */
export async function storedIssueHolds(trackerId: string, nowMs = Date.now()): Promise<StoredIssueHolds> {
  const record = await db.getClawsIssue(trackerId);
  if (!record) return { plannedCount: 0, holds: [] };
  const entries = await db.getIssuePlannedPRs(trackerId);
  const exempt = record.state !== "open" || record.kind !== "issue" || !!record.overlap_hold_lifted_at
    || gh.hasPriorityLabel(record.labels.map((name) => ({ name })));
  if (exempt || entries.length === 0) return { plannedCount: entries.length, holds: [] };
  const ready = await storedReadySteps(record, entries);
  const held = await heldSteps({ id: record.id, priority: false, record }, ready, nowMs);
  return { plannedCount: entries.length, holds: [...held.values()].filter((h): h is OverlapHold => h !== null) };
}

/** Who pressed Start anyway: a dashboard login, or an interactive session. */
export type OverlapLiftActor = { kind: "dashboard"; who: string } | { kind: "session"; sid: string };

/**
 * Start anyway (`POST /issues/:id/overlap/start`, `POST /board/overlap-start`
 * and the `claws_start_issue_anyway` session tool): lift the file-overlap hold
 * for the whole of `trackerId` until it closes. Refused (409) unless the issue
 * is open and currently held ({@link storedOverlapHolds}); 404 for no such
 * native issue. Records the mark and a history entry, and logs `info`
 * `overlap_hold_lifted`.
 */
export async function liftOverlapHold(
  trackerId: string,
  by: OverlapLiftActor,
  nowMs = Date.now(),
): Promise<{ ok: true; hold: OverlapHold } | { ok: false; status: number; error: string }> {
  const record = await db.getClawsIssue(trackerId);
  if (!record || record.kind !== "issue") return { ok: false, status: 404, error: "No such issue" };
  if (record.state !== "open") return { ok: false, status: 409, error: "The issue is closed." };
  const hold = (await storedOverlapHolds([record], nowMs)).get(trackerId);
  if (!hold) return { ok: false, status: 409, error: "The issue is not held for file overlap, so there is nothing to start anyway." };
  const actor = by.kind === "dashboard" ? by.who : `session:${by.sid}`;
  if (!await db.setClawsIssueOverlapHoldLifted(trackerId, actor)) return { ok: false, status: 409, error: "The issue is closed." };
  log.info("overlap_hold_lifted", { component: "overlap-gate", issue: trackerId, by: actor, repo: hold.repo, step: hold.position, waits_on: hold.holders[0]?.issueId ?? null });
  return { ok: true, hold };
}
