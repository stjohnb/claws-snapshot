/**
 * Multi-PR phase coverage — which steps of a multi-PR implementation plan are
 * already covered by a PR (any author, any branch) or an explicit claim comment.
 *
 * Before #2594 the current phase was derived purely from the count of *merged
 * PRs on `claws/issue-<N>-` branches*, so a step implemented out-of-band (by a
 * human or an interactive Claude session working the same issue) was invisible
 * and the pipeline re-implemented it. This module keys on the phase markers
 * Claws itself emits — a `(N/M)` PR-title suffix or a `## PR N of M:` body
 * header — so any PR carrying them counts, plus a `claws-phase-done:` claim
 * comment for steps that produce no PR at all (a manual apply, a dispatch).
 *
 * Trust boundary: phase markers are honoured from any PR author, claims only
 * from `gh.isAllowedActor` logins. The asymmetry is deliberate. A marker is
 * evidence that survives inspection — the PR is linked from the issue timeline,
 * named in the progress comment and in the implementer's prompt, and an
 * untrusted author's PR still cannot merge — whereas a claim asserts that work
 * happened somewhere unreviewable, so it needs an actor Claws already trusts.
 */

import * as gh from "./github.js";
import * as log from "./log.js";

export interface CoveringPR {
  number: number;
  title: string;
  state: "open" | "merged";
}

export interface PhaseCoverage {
  totalPhases: number;
  /** Phase numbers (1-based) already covered. */
  covered: Set<number>;
  /**
   * Phases whose coverage has actually *landed* — a merged PR or an explicit
   * claim. A phase covered only by a still-open PR is in `covered` but not
   * here, because that work can still be closed unmerged or rewritten.
   *
   * Use this, not `covered`, for any decision that is irreversible once the
   * current PR merges — notably whether this is the last phase and may carry
   * `Closes #<issue>` (#2594).
   */
  done: Set<number>;
  /** Phase number → the PR covering it, when a PR (not a claim) covers it. */
  coveringPRs: Map<number, CoveringPR>;
  /** Lowest uncovered phase in 1..totalPhases, or null when all are covered. */
  nextPhase: number | null;
  /** Highest phase covered by a *merged* PR, 0 if none. */
  lastMergedPhase: number;
  /**
   * Phases below `nextPhase` whose only coverage is a still-*open* PR — i.e.
   * work that exists but has not landed on the default branch yet.
   *
   * "Don't duplicate a phase someone already has a PR for" and "it is safe to
   * start the next phase" are different questions: worktrees always branch off
   * `origin/<default>`, so starting phase N+1 while phase N is unmerged builds
   * on a base that is missing its prerequisite. `covered` answers the first
   * question; a non-empty `pendingPhases` means the answer to the second is
   * "wait" rather than "jump ahead".
   */
  pendingPhases: number[];
  /**
   * Merged PRs referencing this issue whose `(n/m)` marker names *more* phases
   * than the plan currently has — i.e. a re-plan dropped `### PR N:` headers
   * that already-merged PRs were numbered against, so phase accounting no
   * longer matches what actually shipped (#2821).
   */
  markerMismatches: MarkerMismatch[];
}

/** A merged PR whose phase marker outnumbers the plan's current phase count. */
export interface MarkerMismatch {
  number: number;
  title: string;
  /** The marker's numerator — which phase this PR was numbered as. */
  phase: number;
  markerTotal: number;
}

export interface CoverageInputPR {
  number: number;
  title: string;
  body: string;
  state: "open" | "merged" | "closed";
}

/** Matches a `claws-phase-done: 1,3-4` claim. The trailing `\d` is required so
 * that documentation text using the `<numbers>` placeholder never self-matches. */
export const PHASE_CLAIM_RE = /claws-phase-done:\s*([\d,\s-]*\d)/i;

/**
 * Matches only when a comment's entire body is a `claws-phase-done:` claim and
 * nothing else. Callers that filter a claim comment out of "feedback for the
 * planner" must use this, not `PHASE_CLAIM_RE` — a comment that carries a claim
 * *and* real feedback (`"claws-phase-done: 1 — also please rename X"`) would
 * otherwise have that feedback silently discarded instead of surfaced.
 */
export const PHASE_CLAIM_ONLY_RE = /^\s*claws-phase-done:\s*[\d,\s-]*\d\s*$/i;

/**
 * Extract the plan phase a PR covers from its title (`… (2/4)`) or body
 * (`## PR 2 of 4: …`). Returns null unless the denominator matches
 * `totalPhases` — a re-plan that changed the phase count invalidates markers
 * written against the old count.
 */
export function parsePhaseMarker(title: string, body: string, totalPhases: number): number | null {
  const m = matchPhaseMarker(title, body);
  if (!m) return null;
  if (m.total !== totalPhases) return null;
  if (m.phase < 1 || m.phase > totalPhases) return null;
  return m.phase;
}

/**
 * The raw `(n/m)` marker on a PR, ignoring the plan's current phase count.
 * Shared by the strict `parsePhaseMarker` and the mismatch detection that needs
 * to see markers the strict parse rejects.
 */
function matchPhaseMarker(title: string, body: string): { phase: number; total: number } | null {
  const fromTitle = title.match(/\((\d+)\s*\/\s*(\d+)\)\s*$/);
  const fromBody = fromTitle ? null : body.match(/^##\s+PR\s+(\d+)\s+of\s+(\d+)\b/m);
  const m = fromTitle ?? fromBody;
  return m ? { phase: Number(m[1]), total: Number(m[2]) } : null;
}

/** True when a PR's title or body references `#issueNumber`. */
export function referencesIssue(pr: { title: string; body: string }, issueNumber: number): boolean {
  const ref = `#${issueNumber}(?!\\d)`;
  if (new RegExp(ref).test(pr.title)) return true;
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part of|for)\\s+${ref}`, "i").test(pr.body);
}

/** Expand a `1, 3-4` claim list into phase numbers within 1..totalPhases. */
function expandClaimList(list: string, totalPhases: number): number[] {
  const out: number[] = [];
  for (const part of list.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      // Clamp *before* iterating: the bounds come straight from comment text, so
      // a typo like `1-99999999999` would otherwise spin the loop for hours and
      // hang the whole process before the post-hoc range filter ever runs.
      const from = Math.max(1, Number(range[1]));
      const to = Math.min(totalPhases, Number(range[2]));
      for (let n = from; n <= to; n++) out.push(n);
      continue;
    }
    const single = trimmed.match(/^\d+$/);
    if (single) out.push(Number(trimmed));
  }
  return out.filter((n) => n >= 1 && n <= totalPhases);
}

/**
 * Collect the phases explicitly claimed complete via `claws-phase-done:`
 * comments. Only comments from allowed actors count, so a stray commenter
 * cannot stall a plan; `trusted` is only consulted for comments that already
 * carry the marker.
 */
export async function parsePhaseClaims(
  comments: { body: string; login: string }[],
  trusted: (login: string) => Promise<boolean>,
  totalPhases: number,
): Promise<Set<number>> {
  const claimed = new Set<number>();
  for (const comment of comments) {
    const m = comment.body.match(PHASE_CLAIM_RE);
    if (!m) continue;
    if (!(await trusted(comment.login))) continue;
    for (const n of expandClaimList(m[1], totalPhases)) claimed.add(n);
  }
  return claimed;
}

export function computePhaseCoverage(input: {
  totalPhases: number;
  legacyMergedPRs: { number: number; title: string }[];
  prs: CoverageInputPR[];
  issueNumber: number;
  claims: Set<number>;
}): PhaseCoverage {
  const { totalPhases, legacyMergedPRs, prs, issueNumber, claims } = input;
  const covered = new Set<number>();
  const coveringPRs = new Map<number, CoveringPR>();
  const mergedPhases = new Set<number>();
  const fromLegacy = new Set<number>();
  const markerMismatches: MarkerMismatch[] = [];

  // (1) Legacy: merged PRs on `claws/issue-<N>-` branches, mapped to phases by
  // position — exactly the accounting that predates #2594, so behaviour is
  // unchanged when no marker or claim is present.
  for (let n = 1; n <= Math.min(legacyMergedPRs.length, totalPhases); n++) {
    covered.add(n);
    mergedPhases.add(n);
    fromLegacy.add(n);
    coveringPRs.set(n, { number: legacyMergedPRs[n - 1].number, title: legacyMergedPRs[n - 1].title, state: "merged" });
  }

  // (2) Markers on cross-referencing PRs. Closed-unmerged PRs are deliberately
  // excluded — counting a rejected duplicate would mark its phase covered forever.
  for (const pr of prs) {
    if (pr.state === "closed") continue;
    if (!referencesIssue(pr, issueNumber)) continue;
    const raw = matchPhaseMarker(pr.title, pr.body);
    // Only a *shrink* is flagged. A re-plan that adds phases leaves merged
    // markers with a smaller denominator, which is legitimate; a denominator
    // larger than the current count means phases silently disappeared.
    if (pr.state === "merged" && raw && raw.total > totalPhases) {
      markerMismatches.push({ number: pr.number, title: pr.title, phase: raw.phase, markerTotal: raw.total });
    }
    const phase = parsePhaseMarker(pr.title, pr.body, totalPhases);
    if (phase === null) continue;
    covered.add(phase);
    if (pr.state === "merged") mergedPhases.add(phase);
    const existing = coveringPRs.get(phase);
    // An explicit marker beats the legacy positional guess, and among markers a
    // merged PR beats an open one — but never the other way round. A legacy
    // entry is by construction backed by an actually-merged PR, so letting an
    // open marker PR (a stale duplicate branch, an abandoned retry) replace it
    // would feed `validateAndUpdatePlan` the wrong diff.
    const replaces = !existing
      || (existing.state === "open" && pr.state === "merged")
      || (fromLegacy.has(phase) && pr.state === "merged");
    if (replaces) {
      coveringPRs.set(phase, { number: pr.number, title: pr.title, state: pr.state });
      fromLegacy.delete(phase);
    }
  }

  // (3) Explicit claims — covered, but with no covering PR to name.
  for (const n of claims) covered.add(n);

  let nextPhase: number | null = null;
  for (let n = 1; n <= totalPhases; n++) {
    if (!covered.has(n)) { nextPhase = n; break; }
  }

  let lastMergedPhase = 0;
  for (const n of mergedPhases) if (n > lastMergedPhase) lastMergedPhase = n;

  const done = new Set<number>();
  for (const n of covered) if (mergedPhases.has(n) || claims.has(n)) done.add(n);

  // Everything below `nextPhase` is covered; the ones that have not landed are
  // covered by an open PR alone, and the next phase must wait for them rather
  // than build on a base that lacks them.
  const pendingPhases: number[] = [];
  for (let n = 1; n < (nextPhase ?? totalPhases + 1); n++) {
    if (!done.has(n)) pendingPhases.push(n);
  }

  markerMismatches.sort((a, b) => a.number - b.number);

  return { totalPhases, covered, done, coveringPRs, nextPhase, lastMergedPhase, pendingPhases, markerMismatches };
}

/**
 * Load phase coverage for an issue: cross-referencing PRs (any author, any
 * branch) matched by phase marker, unioned with `claws-phase-done:` claims and
 * the legacy merged-PR list. Never throws — any failure degrades to the legacy
 * list alone, i.e. the pre-#2594 behaviour.
 */
export async function loadPhaseCoverage(
  fullName: string,
  issueNumber: number,
  totalPhases: number,
  comments: { body: string; login: string }[],
  legacyMergedPRs: { number: number; title: string }[],
): Promise<PhaseCoverage> {
  try {
    const [prs, claims] = await Promise.all([
      gh.listPRsCrossReferencingIssue(fullName, issueNumber),
      parsePhaseClaims(comments, (login) => gh.isAllowedActor(login, fullName), totalPhases),
    ]);
    return computePhaseCoverage({
      totalPhases,
      legacyMergedPRs,
      prs: prs.map((pr) => ({ number: pr.number, title: pr.title, body: pr.body, state: pr.state })),
      issueNumber,
      claims,
    });
  } catch (err) {
    log.warn(`[phase-coverage] Failed to load coverage for ${fullName}#${issueNumber}: ${err}`);
    return computePhaseCoverage({
      totalPhases,
      legacyMergedPRs,
      prs: [],
      issueNumber,
      claims: new Set(),
    });
  }
}
