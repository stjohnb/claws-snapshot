/**
 * Planned PRs — an issue's stored PR list (`claws_issue_prs`) and the phase
 * state derived from it.
 *
 * The planner saves the list through `claws_save_plan` (src/planner-runs.ts),
 * and the refiner writes it onto the issue's tracker record once the plan
 * comment is posted. When a list is stored it is the source of truth for how
 * many PRs the plan needs, which repo each is in and its title; each PR Claws
 * opens is linked to its entry, so a linked entry's coverage is read from that
 * PR's state rather than re-derived from `(N/M)` markers.
 *
 * An issue with no stored list — planned before the list existed, or by a
 * provider that never called the tool — falls back to the legacy path,
 * `parsePlan` + `loadPhaseCoverage`, unchanged.
 */

import * as gh from "./github.js";
import * as db from "./db.js";
import * as log from "./log.js";
import * as planParser from "./plan-parser.js";
import { computePhaseCoverage, finishCoverage, loadPhaseCoverage, parsePhaseClaims, parsePhaseMarker, type CoveringPR, type MarkerMismatch, type PhaseCoverage } from "./phase-coverage.js";
import { canonicalIssueRef, isClawsIssueId, type IssueRef } from "./issue-id.js";
import { issueRefAliases } from "./imported-refs.js";

/**
 * The `claws_issues` id an issue's PR list is keyed by, or null when it has none.
 *
 * A native `clw_…` id is its own tracker id. A forge ref resolves through its
 * `imported_issues` linkage row — its shadow, or the native issue it was
 * imported as. With no row, `create` (the issue's title, author and labels)
 * mints the shadow; readers pass nothing and get null, so a read never writes.
 */
export async function resolveTrackerId(
  repo: string,
  issueRef: IssueRef,
  create?: { title: string; body?: string; authorLogin: string; labels?: readonly string[] },
): Promise<string | null> {
  const ref = canonicalIssueRef(issueRef) ?? issueRef;
  if (isClawsIssueId(ref)) return ref;
  const linked = await db.getLinkedNativeId(repo, ref);
  if (linked) return linked;
  if (!create) return null;
  const shadow = await db.createShadowIssue(repo, ref, create);
  if (shadow) return shadow.id;
  // Undefined means the linkage row names an imported issue: key by that.
  return (await db.getLinkedNativeId(repo, ref)) ?? null;
}

/** An issue's stored PR list and the tracker id it is keyed by. */
export interface StoredPlannedPRs {
  trackerId: string;
  entries: db.IssuePlannedPR[];
}

/**
 * The issue's stored PR list, or null when it has none (or the read failed —
 * logged, and treated as "no list" so callers fall back to the plan text).
 * Database reads only.
 */
export async function loadStoredPlannedPRs(repo: string, issueRef: IssueRef): Promise<StoredPlannedPRs | null> {
  try {
    const trackerId = await resolveTrackerId(repo, issueRef);
    if (!trackerId) return null;
    const entries = await db.getIssuePlannedPRs(trackerId);
    return entries.length > 0 ? { trackerId, entries } : null;
  } catch (err) {
    log.warn(`[planned-prs] Could not read the stored PR list for ${repo}#${issueRef} — using the plan text: ${err}`);
    return null;
  }
}

/**
 * The plan's PR count without loading coverage: the stored list's length, or
 * the plan text's `### PR N:` count. Database reads only, so a caller that
 * acts only on multi-PR plans can skip the forge reads for every other issue.
 * Returns the stored list too, for passing on to `loadIssuePhaseState`.
 */
export async function peekTotalPhases(repo: string, issueRef: IssueRef, planText: string | null): Promise<{ totalPhases: number; stored: StoredPlannedPRs | null }> {
  const stored = await loadStoredPlannedPRs(repo, issueRef);
  if (stored) return { totalPhases: stored.entries.length, stored };
  return { totalPhases: planText ? planParser.parsePlan(planText).totalPhases : 1, stored: null };
}

export interface IssuePhaseState {
  totalPhases: number;
  coverage: PhaseCoverage;
  /** The stored list, or null when the legacy path was used. */
  entries: db.IssuePlannedPR[] | null;
  /** The tracker id the list is keyed by, when one resolved. */
  trackerId: string | null;
}

type MergedPRList = { number: number; title: string; body?: string }[];

/**
 * Phase state for an issue: the stored PR list first, the legacy
 * `### PR N:` + `(N/M)` accounting otherwise. Never throws on a coverage-read
 * failure — like `loadPhaseCoverage`, it degrades to "nothing covered" rather
 * than stalling a dispatcher tick.
 *
 * `planText` defaults to the issue's plan comment, `mergedPRs` to
 * `gh.listMergedPRsForIssue` and `stored` to `loadStoredPlannedPRs`; pass
 * them when the caller already has them.
 */
export async function loadIssuePhaseState(
  repo: string,
  issueRef: IssueRef,
  comments: { body: string; login: string }[],
  opts: { planText?: string | null; mergedPRs?: MergedPRList; stored?: StoredPlannedPRs | null } = {},
): Promise<IssuePhaseState> {
  let mergedCache: MergedPRList | undefined = opts.mergedPRs;
  const mergedPRs = async (): Promise<MergedPRList> => (mergedCache ??= await gh.listMergedPRsForIssue(repo, issueRef));

  const stored = opts.stored !== undefined ? opts.stored : await loadStoredPlannedPRs(repo, issueRef);
  const planText = opts.planText !== undefined ? opts.planText : planParser.findPlanComment(comments);
  const plan = planText ? planParser.parsePlan(planText) : null;
  if (stored) {
    const dependsOn = storedDependencies(stored.entries, plan);
    let coverage = await storedCoverage(repo, issueRef, stored.trackerId, stored.entries, comments, mergedPRs, dependsOn);
    // Only an unlinked entry's coverage comes from the cross-reference scan,
    // which has gaps this fills in — see foldOpenBranchPRs. `linkPlannedPR` is
    // best-effort, so an unlinked entry may be in a repo other than `repo`;
    // fold every repo among the unlinked entries, not just the issue's own.
    const unlinkedEntries = stored.entries.filter((e) => e.prNumber === null);
    if (unlinkedEntries.length > 0) {
      const unlinkedRepos = [...new Set(unlinkedEntries.map((e) => e.repo))];
      coverage = await foldOpenBranchPRs(unlinkedRepos, issueRef, stored.entries.length, coverage);
    }
    return { totalPhases: stored.entries.length, coverage, entries: stored.entries, trackerId: stored.trackerId };
  }

  const totalPhases = plan ? plan.totalPhases : 1;
  let coverage = await loadPhaseCoverage(repo, issueRef, totalPhases, comments, await mergedPRs(), plan?.phases.map((p) => p.dependsOn));
  coverage = await foldOpenBranchPRs([repo], issueRef, totalPhases, coverage);
  return { totalPhases, coverage, entries: null, trackerId: null };
}

/**
 * Union open PRs cut from the issue's branch, in every repo in `repos`, into
 * coverage that was derived from a cross-reference scan:
 * `listPRsCrossReferencingIssue` always returns `[]` on Forgejo, misses a PR
 * whose body never says `Part of #…`, and is 60 s-cached on GitHub with no
 * invalidation, so a PR opened moments ago can still be invisible. Branch PRs
 * are cheap to check — `listOpenPRsForIssue` reads off the same cached
 * open-PR list `listPRs` already keeps — and close that gap directly rather
 * than depending on the scan finding them.
 *
 * `repos` is the issue's own repo on the legacy path, or the distinct repos
 * among a stored list's unlinked entries: `linkPlannedPR` is best-effort, so
 * an entry for another repo can stay unlinked while its PR is open there.
 *
 * When an open branch PR's phase cannot be determined (an unmarked PR on a
 * multi-phase plan), the whole issue is left with nothing ready: an unknown
 * in-flight PR should block further dispatch rather than risk a duplicate
 * implementation of the phase it may already cover.
 */
async function foldOpenBranchPRs(
  repos: readonly string[],
  issueRef: IssueRef,
  totalPhases: number,
  coverage: PhaseCoverage,
): Promise<PhaseCoverage> {
  const branchPRs = (await Promise.all(repos.map((r) => gh.listOpenPRsForIssue(r, issueRef)))).flat();
  if (branchPRs.length === 0) return coverage;

  const covered = new Set(coverage.covered);
  const coveringPRs = new Map(coverage.coveringPRs);
  const merged = new Set<number>();
  for (const n of coverage.done) {
    if (coverage.coveringPRs.get(n)?.state === "merged") merged.add(n);
  }

  let unknownPhase = false;
  for (const pr of branchPRs) {
    const phase = parsePhaseMarker(pr.title, pr.body ?? "", totalPhases) ?? (totalPhases === 1 ? 1 : null);
    if (phase === null) { unknownPhase = true; continue; }
    covered.add(phase);
    if (!coveringPRs.has(phase)) coveringPRs.set(phase, { number: pr.number, title: pr.title, state: "open" });
  }

  const dependsOn = Array.from({ length: totalPhases }, (_, i) => coverage.dependencies.get(i + 1) ?? null);
  const finished = finishCoverage(totalPhases, covered, coverage.done, merged, dependsOn);
  return {
    ...finished,
    covered,
    done: coverage.done,
    coveringPRs,
    markerMismatches: coverage.markerMismatches,
    readyPhases: unknownPhase ? [] : finished.readyPhases,
    blockedPhases: unknownPhase ? [...finished.blockedPhases, ...finished.readyPhases].sort((a, b) => a - b) : finished.blockedPhases,
  };
}

/**
 * Per-phase declared dependencies for a stored list: each entry's own
 * `dependsOn`, else its plan header's suffix when the headers line up with the
 * list. Null entries fall back to "after the previous PR" in `finishCoverage`.
 */
function storedDependencies(entries: readonly db.IssuePlannedPR[], plan: planParser.ParsedPlan | null): (number[] | null)[] {
  const aligned = plan !== null && plan.totalPhases === entries.length;
  return entries.map((e, i) => e.dependsOn ?? (aligned ? plan.phases[i].dependsOn : null) ?? null);
}

/**
 * Whether any PR of the issue's plan has merged — the "agreed and partly
 * shipped" test the stale-plan guards use. Unions the branch-prefix merged
 * list, which only sees the issue's own repo, with the stored list's coverage,
 * which reads each linked PR in its own repo, so a multi-repo plan whose merged
 * steps all landed in another repo still counts. `comments` is fetched only
 * when a stored list exists and the caller did not pass it.
 */
export async function issueHasShippedWork(
  repo: string,
  issueRef: IssueRef,
  comments?: { body: string; login: string }[],
): Promise<boolean> {
  const mergedPRs = await gh.listMergedPRsForIssue(repo, issueRef);
  if (mergedPRs.length > 0) return true;
  const stored = await loadStoredPlannedPRs(repo, issueRef);
  if (!stored) return false;
  const { coverage } = await loadIssuePhaseState(
    repo, issueRef, comments ?? await gh.getIssueComments(repo, issueRef), { mergedPRs, stored },
  );
  return coverage.done.size > 0;
}

/** An open PR implementing one of an issue's plan steps. */
export interface OpenPhasePR {
  repo: string;
  number: number;
  title: string;
  /** The plan step it covers, or null when neither a link nor a marker says. */
  phase: number | null;
}

/**
 * Every open PR working on the issue, in any of its repos: the issue repo's
 * open `claws/issue-<ref>-` PRs unioned with the stored list's linked entries
 * whose PR is open in the entry's own repo. A parallel plan can have several at
 * once, and a multi-repo plan's current PR may be outside the issue repo, so
 * "is there an open PR" questions must ask this rather than
 * `gh.getOpenPRForIssue`.
 *
 * A linked PR whose state cannot be read counts as open, as in
 * `storedCoverage`. `comments` is read only to number branch PRs when there is
 * no stored list; it is fetched when needed and not passed.
 */
export async function listOpenPhasePRs(
  repo: string,
  issueRef: IssueRef,
  comments?: { body: string; login: string }[],
): Promise<OpenPhasePR[]> {
  const [branchPRs, stored] = await Promise.all([
    gh.listOpenPRsForIssue(repo, issueRef),
    loadStoredPlannedPRs(repo, issueRef),
  ]);
  const byKey = new Map<string, OpenPhasePR>();

  let totalPhases = stored?.entries.length ?? 0;
  if (!stored && branchPRs.length > 0) {
    const planText = planParser.findPlanComment(comments ?? await gh.getIssueComments(repo, issueRef));
    totalPhases = planText ? planParser.parsePlan(planText).totalPhases : 1;
  }
  for (const pr of branchPRs) {
    const phase = parsePhaseMarker(pr.title, pr.body ?? "", totalPhases) ?? (totalPhases === 1 ? 1 : null);
    byKey.set(`${repo}#${pr.number}`, { repo, number: pr.number, title: pr.title, phase });
  }

  if (stored) {
    // The issue's own repo already has a cached open-PR list — from
    // `listPRs`, the same source `listOpenPRsForIssue` above reads — so a
    // same-repo entry's "is it open?" answer comes from there instead of an
    // uncached `gh pr view` per entry. Only an entry naming one of a
    // multi-repo plan's other repos still needs its own live read.
    let sameRepoOpen: Map<number, gh.PR> | null = null;
    if (stored.entries.some((e) => e.repo === repo)) {
      sameRepoOpen = new Map((await gh.listPRs(repo)).map((pr) => [pr.number, pr]));
    }
    await Promise.all(stored.entries.map(async (entry) => {
      if (entry.prNumber === null) return;
      const key = `${entry.repo}#${entry.prNumber}`;
      if (entry.repo === repo) {
        const pr = sameRepoOpen!.get(entry.prNumber);
        if (!pr) { byKey.delete(key); return; }
        const existing = byKey.get(key);
        byKey.set(key, { repo: entry.repo, number: entry.prNumber, title: existing?.title ?? pr.title ?? entry.title, phase: entry.position });
        return;
      }
      let state: string;
      try {
        state = (await gh.getPRState(entry.repo, entry.prNumber)) ?? "OPEN";
      } catch (err) {
        log.warn(`[planned-prs] Could not read ${key} for ${repo}#${issueRef} step ${entry.position} — treating it as open: ${err}`);
        state = "OPEN";
      }
      if (state.toUpperCase() !== "OPEN") {
        // The branch list may be cached; this direct read is the fresher answer.
        byKey.delete(key);
        return;
      }
      const existing = byKey.get(key);
      byKey.set(key, { repo: entry.repo, number: entry.prNumber, title: existing?.title ?? entry.title, phase: entry.position });
    }));
  }

  return [...byKey.values()].sort((a, b) => (a.phase ?? Infinity) - (b.phase ?? Infinity) || a.number - b.number);
}

/**
 * Coverage over a stored list. A linked entry's state is its PR's: merged is
 * done, open is covered but pending, and closed-unmerged unlinks the entry and
 * leaves it uncovered. A PR the forge cannot read or find keeps its link and
 * counts as open — a null answer may be a 403 or a network failure. Unlinked
 * entries fall back to the marker/claim accounting of `computePhaseCoverage`,
 * restricted to those positions.
 */
async function storedCoverage(
  repo: string,
  issueRef: IssueRef,
  trackerId: string,
  entries: db.IssuePlannedPR[],
  comments: { body: string; login: string }[],
  mergedPRs: () => Promise<MergedPRList>,
  dependsOn: (number[] | null)[],
): Promise<PhaseCoverage> {
  const totalPhases = entries.length;
  const covered = new Set<number>();
  const done = new Set<number>();
  const merged = new Set<number>();
  const coveringPRs = new Map<number, CoveringPR>();
  const unlinked: db.IssuePlannedPR[] = [];
  // PRs already accounted for by a link, keyed `repo#number`, so the fallback
  // cannot count them twice.
  const linkedPRs = new Set<string>();
  let markerMismatches: MarkerMismatch[] = [];

  await Promise.all(entries.map(async (entry) => {
    if (entry.prNumber === null) {
      unlinked.push(entry);
      return;
    }
    let state: string;
    try {
      // A missing PR is treated the same as a read failure: keeping the link and
      // counting it as open avoids re-implementing a step during a transient
      // outage, at the cost of never auto-unlinking a genuinely deleted PR.
      const read = await gh.getPRState(entry.repo, entry.prNumber);
      if (read === null) log.warn(`[planned-prs] ${entry.repo}#${entry.prNumber} for ${repo}#${issueRef} step ${entry.position} could not be found — keeping the link and treating it as open`);
      state = read ?? "OPEN";
    } catch (err) {
      // Unknown is treated as still open: it keeps the step from being
      // re-implemented and the next one from starting until the read succeeds.
      log.warn(`[planned-prs] Could not read ${entry.repo}#${entry.prNumber} for ${repo}#${issueRef} step ${entry.position}: ${err}`);
      state = "OPEN";
    }
    const upper = state.toUpperCase();
    if (upper === "MERGED" || upper === "OPEN") {
      covered.add(entry.position);
      linkedPRs.add(`${entry.repo}#${entry.prNumber}`);
      const isMerged = upper === "MERGED";
      if (isMerged) {
        done.add(entry.position);
        merged.add(entry.position);
      }
      coveringPRs.set(entry.position, { number: entry.prNumber, title: entry.title, state: isMerged ? "merged" : "open" });
      return;
    }
    log.info(`[planned-prs] ${entry.repo}#${entry.prNumber} for ${repo}#${issueRef} step ${entry.position} is ${upper} — unlinking it`);
    try {
      await db.unlinkIssuePlannedPR(trackerId, entry.position);
    } catch (err) {
      log.warn(`[planned-prs] Could not unlink step ${entry.position} of ${repo}#${issueRef}: ${err}`);
    }
    unlinked.push(entry);
  }));

  if (unlinked.length > 0) {
    try {
      const claims = await parsePhaseClaims(comments, (login) => gh.isAllowedActor(login, repo, issueRef), totalPhases);
      // Each unlinked entry is looked for in its own repo — a multi-repo plan's
      // step in repo B opens its PR in B, not in the issue's primary repo. The
      // branch-prefix merged list is the issue repo's, so only that repo's
      // entries use it.
      const byRepo = new Map<string, number[]>();
      for (const entry of unlinked) byRepo.set(entry.repo, [...(byRepo.get(entry.repo) ?? []), entry.position]);
      markerMismatches = (await Promise.all([...byRepo].map(async ([entryRepo, positions]) => {
        const notLinked = (n: number) => !linkedPRs.has(`${entryRepo}#${n}`);
        const [prs, legacy] = await Promise.all([
          gh.listPRsCrossReferencingIssue(entryRepo, issueRef),
          entryRepo === repo ? mergedPRs() : Promise.resolve([]),
        ]);
        const fallback = computePhaseCoverage({
          totalPhases,
          legacyMergedPRs: legacy.filter((pr) => notLinked(pr.number)),
          prs: prs
            .filter((pr) => notLinked(pr.number))
            .map((pr) => ({ number: pr.number, title: pr.title, body: pr.body, state: pr.state })),
          issueNumber: issueRef,
          claims,
          issueRefs: issueRefAliases(entryRepo, issueRef),
        });
        for (const n of positions) {
          if (fallback.covered.has(n)) covered.add(n);
          if (fallback.done.has(n)) done.add(n);
          const pr = fallback.coveringPRs.get(n);
          if (pr) {
            coveringPRs.set(n, pr);
            if (pr.state === "merged") merged.add(n);
          }
        }
        return fallback.markerMismatches;
      }))).flat().sort((a, b) => a.number - b.number);
    } catch (err) {
      log.warn(`[planned-prs] Failed to load fallback coverage for ${repo}#${issueRef}: ${err}`);
    }
  }

  return { ...finishCoverage(totalPhases, covered, done, merged, dependsOn), covered, done, coveringPRs, markerMismatches };
}

/**
 * The plan the implementer works from, given the stored list. When the plan's
 * `### PR N:` headers line up with the list, the list's titles win and each
 * header's section is the phase description. When they do not, each phase's
 * description is the whole plan plus "You are implementing PR N of M: <title>".
 */
export function alignPlanWithEntries(
  plan: planParser.ParsedPlan | null,
  entries: readonly db.IssuePlannedPR[] | null,
): planParser.ParsedPlan | null {
  if (!entries || entries.length === 0) return plan;
  const total = entries.length;
  if (plan && plan.totalPhases === total) {
    return {
      ...plan,
      phases: plan.phases.map((p, i) => ({ ...p, title: entries[i]?.title ?? p.title, dependsOn: entries[i]?.dependsOn ?? p.dependsOn })),
    };
  }
  const fullPlan = plan
    ? [plan.preamble, ...(plan.totalPhases > 1 ? plan.phases.map((p) => `### PR ${p.phaseNumber}: ${p.title}${planParser.formatDependencySuffix(p.dependsOn)}\n${p.description}`) : [])]
        .filter((s) => s.trim()).join("\n\n")
    : "";
  return {
    preamble: fullPlan,
    phases: entries.map((e, i) => ({
      phaseNumber: i + 1,
      title: e.title,
      description: `You are implementing PR ${i + 1} of ${total}: ${e.title}`,
      dependsOn: e.dependsOn,
    })),
    totalPhases: total,
  };
}
