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
 * The legacy merged-PR list is matched by marker first and falls back to
 * position only for unmarked PRs.
 *
 * Trust boundary: phase markers are honoured from any PR author, claims only
 * from `gh.isAllowedActor` logins. The asymmetry is deliberate. A marker is
 * evidence that survives inspection — the PR is linked from the issue timeline,
 * named in the progress comment and in the implementer's prompt, and an
 * untrusted author's PR still cannot merge — whereas a claim asserts that work
 * happened somewhere unreviewable, so it needs an actor Claws already trusts.
 *
 * A claim must also be *asserted*, not merely described (#3154): it is anchored
 * to the start of its own line, text inside a fenced code block or a blockquote
 * is ignored, and a comment carrying the "Automated by Claws" footer is never
 * read as a claim — the docs have always promised that last rule but nothing
 * enforced it, so the planner claimed a step by explaining how steps are
 * claimed. PR-side `(N/M)` markers are unaffected and stay honoured from any
 * author.
 *
 * Single-phase plans also count an open PR whose body closes the issue, so
 * that target-PR pushes (a plan implemented onto an already-open PR's branch)
 * are recognised even though such a PR never carries a phase marker (#3050).
 */

import * as gh from "./github.js";
import * as log from "./log.js";
import { stripQuotedRegions } from "./marker-text.js";
import { ISSUE_REF_GUARDED, ISSUE_REF_BOUNDARY, canonicalIssueRef, sameIssueRef, type IssueRef } from "./issue-id.js";
import { issueRefAliases } from "./imported-refs.js";

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
   * Phase → the earlier phases it must land after (its effective
   * dependencies): the stored list's `depends_on`, else the plan header's
   * suffix, else the previous phase (`[]` for phase 1).
   */
  dependencies: Map<number, number[]>;
  /**
   * Uncovered phases whose every transitive dependency is in `done` — work
   * that could start now, lowest first.
   *
   * "Don't duplicate a phase someone already has a PR for" and "it is safe to
   * start this phase" are different questions: worktrees always branch off
   * `origin/<default>`, so starting a phase while one it depends on is
   * unmerged builds on a base that is missing its prerequisite. `covered`
   * answers the first question, readiness the second. With no dependency
   * information this is `[nextPhase]` exactly when every phase below
   * `nextPhase` is done.
   */
  readyPhases: number[];
  /** Uncovered phases that are not ready — some dependency has not landed. */
  blockedPhases: number[];
  /** Covered but not done phases (an open PR alone covers them), at any position. */
  openPhases: number[];
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

/**
 * Matches a `claws-phase-done: 1,3-4` claim. Anchored to the start of its own
 * line, like `CLAWS_NO_CODE_CHANGES` / `CLAWS_BLOCKED` / `CLAWS_TRANSFER_TO:`,
 * so a mid-sentence mention is prose rather than a claim, and the value class
 * excludes newlines so it cannot run past that line. The trailing `\d` is
 * required so that documentation text using the `<numbers>` placeholder never
 * self-matches. Match against `stripQuotedRegions(body)`, never a raw body.
 */
export const PHASE_CLAIM_RE = /^[ \t]*claws-phase-done:[ \t]*([\d,\t -]*\d)/im;

/**
 * Matches only when a comment's entire body is a `claws-phase-done:` claim and
 * nothing else. Callers that filter a claim comment out of "feedback for the
 * planner" must use this, not `PHASE_CLAIM_RE` — a comment that carries a claim
 * *and* real feedback (`"claws-phase-done: 1 — also please rename X"`) would
 * otherwise have that feedback silently discarded instead of surfaced.
 *
 * Prefer `isPhaseClaimOnly`, which blanks quoted regions first; the pattern
 * stays exported for tests and callers that already hold cleaned text.
 */
export const PHASE_CLAIM_ONLY_RE = /^\s*claws-phase-done:\s*[\d,\s-]*\d\s*$/i;

/** True when a comment is *only* an asserted claim, with no feedback alongside. */
export function isPhaseClaimOnly(body: string): boolean {
  return PHASE_CLAIM_ONLY_RE.test(stripQuotedRegions(body));
}

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

/**
 * Literal ref plus the boundary guard its shape needs, or null when `issueRef`
 * is not a reference at all.
 *
 * Null rather than a fallback to the raw input: the result becomes regex
 * *source*, so an un-canonical ref that slipped through would either throw a
 * `SyntaxError` out of `new RegExp` or quietly match the wrong thing (`"12."`
 * matches `#121`). Every entry point canonicalises, so refusing here is the
 * honest behaviour for a ref that somehow did not.
 */
function refPattern(issueRef: IssueRef): string | null {
  const canonical = canonicalIssueRef(issueRef);
  if (canonical === null) return null;
  // A numeric ref needs only a digit guard; a `clw_…` id needs the wider
  // alphanumeric one, or `clw_<26>X` would match its first 26 characters.
  const boundary = typeof canonical === "number" ? "(?!\\d)" : ISSUE_REF_BOUNDARY;
  return `#${canonical}${boundary}`;
}

/** True when a PR's title or body references `#issueRef`. */
export function referencesIssue(pr: { title: string; body: string }, issueRef: IssueRef): boolean {
  const ref = refPattern(issueRef);
  if (ref === null) return false;
  if (new RegExp(ref, "i").test(pr.title)) return true;
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part of|for)\\s+${ref}`, "i").test(pr.body);
}

/**
 * True when a PR body uses a GitHub closing keyword (close/closes/closed,
 * fix/fixes/fixed, resolve/resolves/resolved) against `#issueRef` — i.e.
 * the PR says it finishes the issue, not merely that it relates to it.
 */
export function closesIssue(body: string, issueRef: IssueRef): boolean {
  return extractClosedIssueRefs(body).some((ref) => sameIssueRef(ref, issueRef));
}

const CLOSING_REF_RE = new RegExp(
  `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#(${ISSUE_REF_GUARDED})`,
  "gi",
);

/**
 * Every issue reference a PR body closes, in body order and de-duplicated.
 *
 * The caller-facing counterpart to `closesIssue` for when the refs are not
 * known up front (the merger closing the native issues a merged PR names).
 * Quoted regions are stripped first, so a `Closes #N` inside a code fence or
 * a blockquote is discussion rather than an instruction — the same rule this
 * module already applies to phase claims.
 */
export function extractClosedIssueRefs(body: string): IssueRef[] {
  const out: IssueRef[] = [];
  for (const m of stripQuotedRegions(body).matchAll(CLOSING_REF_RE)) {
    const ref = canonicalIssueRef(m[1]);
    if (ref === null || out.includes(ref)) continue;
    out.push(ref);
  }
  return out;
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
 *
 * A Claws-authored comment never counts, however trusted its login: Claws posts
 * the claim *instructions*, and matching them turned the planner's own plan
 * into a claim on the step it was describing (#3154). Nothing in Claws posts a
 * digit-bearing claim, so no legitimate claim is lost. Quoted text — a fenced
 * operator example, a blockquote — is description too, not assertion.
 */
export async function parsePhaseClaims(
  comments: { body: string; login: string }[],
  trusted: (login: string) => Promise<boolean>,
  totalPhases: number,
): Promise<Set<number>> {
  const claimed = new Set<number>();
  for (const comment of comments) {
    if (gh.isClawsComment(comment.body)) continue;
    const m = stripQuotedRegions(comment.body).match(PHASE_CLAIM_RE);
    if (!m) continue;
    if (!(await trusted(comment.login))) continue;
    for (const n of expandClaimList(m[1], totalPhases)) claimed.add(n);
  }
  return claimed;
}

export function computePhaseCoverage(input: {
  totalPhases: number;
  legacyMergedPRs: { number: number; title: string; body?: string }[];
  prs: CoverageInputPR[];
  issueNumber: IssueRef;
  claims: Set<number>;
  /**
   * Every spelling of `issueNumber` a PR may reference — `issueRefAliases`,
   * canonical ref first. A PR opened before the issue was imported says
   * `Part of #<forge number>`, which the native id alone never matches, so
   * without this the cross-reference fan-out in `listPRsCrossReferencingIssue`
   * is undone one line later by the `referencesIssue` re-filter (#3245).
   * Defaults to `issueNumber` alone.
   */
  issueRefs?: IssueRef[];
  /** Per-phase declared dependencies, index phase-1; see `finishCoverage`. */
  dependsOn?: readonly (readonly number[] | null)[];
}): PhaseCoverage {
  const { totalPhases, legacyMergedPRs, prs, issueNumber, claims } = input;
  const issueRefs = input.issueRefs?.length ? input.issueRefs : [issueNumber];
  const covered = new Set<number>();
  const coveringPRs = new Map<number, CoveringPR>();
  const mergedPhases = new Set<number>();
  const fromLegacy = new Set<number>();
  const markerMismatches: MarkerMismatch[] = [];
  const mismatchSeen = new Set<number>();

  // (1) Legacy: merged PRs on `claws/issue-<N>-` branches. Markers on legacy
  // PRs win over position; only unmarked PRs fall back to positional fill. This
  // matters on Forgejo, where cross-reference lookup returns [] and the legacy
  // list is newest-first, which silently reversed a two-PR plan before #2972.
  const unmarkedLegacyPRs: { number: number; title: string; body?: string }[] = [];
  for (const pr of legacyMergedPRs) {
    const raw = matchPhaseMarker(pr.title, pr.body ?? "");
    if (raw && raw.total > totalPhases && !mismatchSeen.has(pr.number)) {
      markerMismatches.push({ number: pr.number, title: pr.title, phase: raw.phase, markerTotal: raw.total });
      mismatchSeen.add(pr.number);
    }

    const phase = parsePhaseMarker(pr.title, pr.body ?? "", totalPhases);
    if (phase === null) {
      unmarkedLegacyPRs.push(pr);
      continue;
    }
    if (coveringPRs.has(phase)) continue;
    covered.add(phase);
    mergedPhases.add(phase);
    coveringPRs.set(phase, { number: pr.number, title: pr.title, state: "merged" });
  }

  let slot = 1;
  for (const pr of unmarkedLegacyPRs.sort((a, b) => a.number - b.number)) {
    while (slot <= totalPhases && coveringPRs.has(slot)) slot++;
    if (slot > totalPhases) break;
    covered.add(slot);
    mergedPhases.add(slot);
    fromLegacy.add(slot);
    coveringPRs.set(slot, { number: pr.number, title: pr.title, state: "merged" });
    slot++;
  }

  // (2) Markers on cross-referencing PRs. Closed-unmerged PRs are deliberately
  // excluded — counting a rejected duplicate would mark its phase covered forever.
  for (const pr of prs) {
    if (pr.state === "closed") continue;
    if (!issueRefs.some((ref) => referencesIssue(pr, ref))) continue;
    const raw = matchPhaseMarker(pr.title, pr.body);
    // Only a *shrink* is flagged. A re-plan that adds phases leaves merged
    // markers with a smaller denominator, which is legitimate; a denominator
    // larger than the current count means phases silently disappeared.
    if (pr.state === "merged" && raw && raw.total > totalPhases && !mismatchSeen.has(pr.number)) {
      markerMismatches.push({ number: pr.number, title: pr.title, phase: raw.phase, markerTotal: raw.total });
      mismatchSeen.add(pr.number);
    }
    const phase = parsePhaseMarker(pr.title, pr.body, totalPhases);
    if (phase === null) {
      // A single-phase plan has no marker to carry, so an open PR that closes
      // the issue (e.g. a CLAWS_TARGET_PR push, #3050) counts as phase 1 on its
      // own. The work hasn't landed yet, so it's left out of `mergedPhases`.
      if (totalPhases === 1 && pr.state === "open" && issueRefs.some((ref) => closesIssue(pr.body, ref))) {
        covered.add(1);
        if (!coveringPRs.has(1)) {
          coveringPRs.set(1, { number: pr.number, title: pr.title, state: "open" });
        }
      }
      continue;
    }
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

  const done = new Set<number>();
  for (const n of covered) if (mergedPhases.has(n) || claims.has(n)) done.add(n);

  markerMismatches.sort((a, b) => a.number - b.number);

  return {
    ...finishCoverage(totalPhases, covered, done, mergedPhases, input.dependsOn),
    covered, done, coveringPRs, markerMismatches,
  };
}

/**
 * The effective dependencies of each phase 1..totalPhases: the declared list
 * when there is one (only lower positions kept, so there are no cycles), else
 * the previous phase. Exported for reporting.
 */
export function effectiveDependencies(
  totalPhases: number,
  dependsOn?: readonly (readonly number[] | null)[],
): Map<number, number[]> {
  const deps = new Map<number, number[]>();
  for (let n = 1; n <= totalPhases; n++) {
    const declared = dependsOn?.[n - 1];
    deps.set(n, declared
      ? [...new Set(declared)].filter((d) => Number.isInteger(d) && d >= 1 && d < n).sort((a, b) => a - b)
      : n === 1 ? [] : [n - 1]);
  }
  return deps;
}

/**
 * The fields derived from which phases are covered, done and merged: the next
 * phase, the last merged phase and dependency readiness. Shared by
 * `computePhaseCoverage` and the stored-list path in `planned-prs.ts`.
 *
 * A phase is ready when it is uncovered and every phase in the transitive
 * closure of its dependencies is done. With no declared dependencies each
 * phase depends on the previous one, so a phase is ready only once every phase
 * before it has landed.
 */
export function finishCoverage(
  totalPhases: number,
  covered: ReadonlySet<number>,
  done: ReadonlySet<number>,
  merged: ReadonlySet<number>,
  dependsOn?: readonly (readonly number[] | null)[],
): Pick<PhaseCoverage, "totalPhases" | "nextPhase" | "lastMergedPhase" | "dependencies" | "readyPhases" | "blockedPhases" | "openPhases"> {
  let nextPhase: number | null = null;
  for (let n = 1; n <= totalPhases; n++) {
    if (!covered.has(n)) { nextPhase = n; break; }
  }

  let lastMergedPhase = 0;
  for (const n of merged) if (n > lastMergedPhase) lastMergedPhase = n;

  const dependencies = effectiveDependencies(totalPhases, dependsOn);
  // Dependencies only name lower phases, so walking upwards resolves each
  // phase's closure from already-computed ones.
  const landed = new Map<number, boolean>();
  for (let n = 1; n <= totalPhases; n++) {
    landed.set(n, dependencies.get(n)!.every((d) => done.has(d) && landed.get(d)));
  }
  const readyPhases: number[] = [];
  const blockedPhases: number[] = [];
  const openPhases: number[] = [];
  for (let n = 1; n <= totalPhases; n++) {
    if (covered.has(n)) {
      if (!done.has(n)) openPhases.push(n);
    } else if (landed.get(n)) {
      readyPhases.push(n);
    } else {
      blockedPhases.push(n);
    }
  }

  return { totalPhases, nextPhase, lastMergedPhase, dependencies, readyPhases, blockedPhases, openPhases };
}

/**
 * Load phase coverage for an issue: cross-referencing PRs (any author, any
 * branch) matched by phase marker, unioned with `claws-phase-done:` claims and
 * the legacy merged-PR list. Never throws — any failure degrades to the legacy
 * list alone, i.e. the pre-#2594 behaviour.
 */
export async function loadPhaseCoverage(
  fullName: string,
  issueNumber: IssueRef,
  totalPhases: number,
  comments: { body: string; login: string }[],
  legacyMergedPRs: { number: number; title: string; body?: string }[],
  dependsOn?: readonly (readonly number[] | null)[],
): Promise<PhaseCoverage> {
  // Resolved once and passed down: `listPRsCrossReferencingIssue` fans out over
  // the same aliases, so `computePhaseCoverage` has to accept a PR under any of
  // them or it discards everything the fan-out just found (#3245).
  const issueRefs = issueRefAliases(fullName, issueNumber);
  try {
    const [prs, claims] = await Promise.all([
      gh.listPRsCrossReferencingIssue(fullName, issueNumber),
      parsePhaseClaims(comments, (login) => gh.isAllowedActor(login, fullName, issueNumber), totalPhases),
    ]);
    return computePhaseCoverage({
      totalPhases,
      legacyMergedPRs,
      prs: prs.map((pr) => ({ number: pr.number, title: pr.title, body: pr.body, state: pr.state })),
      issueNumber,
      claims,
      issueRefs,
      dependsOn,
    });
  } catch (err) {
    log.warn(`[phase-coverage] Failed to load coverage for ${fullName}#${issueNumber}: ${err}`);
    return computePhaseCoverage({
      totalPhases,
      legacyMergedPRs,
      prs: [],
      issueNumber,
      claims: new Set(),
      issueRefs,
      dependsOn,
    });
  }
}
