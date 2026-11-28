/**
 * File-overlap prediction between in-flight work (#clw_01M7WDMJ9GCF6MCZ0BPKN3333S).
 * Pure: path normalisation and validation, overlap matching, the repo's
 * ignore list, the shared-docs rule, the total order in-flight steps run in,
 * the give-way rule, which steps hold at all ({@link resolveHolding}) and
 * which steps ahead of a step hold it. `overlap-gate.ts` loads the in-flight
 * steps from the database and applies these.
 *
 * Paths are repo-relative and matched case-sensitively: two paths overlap when
 * they are equal or one is a directory prefix of the other. There are no globs,
 * in declarations or the ignore list.
 */

/** Longest path accepted, in characters. */
export const MAX_OVERLAP_PATH_LENGTH = 300;

/** A holder stops holding once it has been in flight this long (Decision 8). */
export const OVERLAP_GIVE_WAY_MS = 48 * 60 * 60 * 1000;

const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Why `raw` is not a valid repo-relative path, or null when it is. Rejects an
 * empty path, the repo root, a leading `/`, a `..` segment, a backslash, a
 * glob character, and anything longer than {@link MAX_OVERLAP_PATH_LENGTH}.
 */
export function overlapPathError(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "is empty";
  if (value.length > MAX_OVERLAP_PATH_LENGTH) return `is longer than ${MAX_OVERLAP_PATH_LENGTH} characters`;
  if (value.startsWith("/")) return "must be repo-relative (no leading /)";
  if (value.includes("\\")) return "must use / as the separator";
  if (GLOB_CHARS.test(value)) return "must not contain glob characters (* ? [ ] { })";
  if (value.split("/").includes("..")) return "must not contain a .. segment";
  if (normaliseOverlapPath(value) === "") return "must not name the repo root";
  return null;
}

/**
 * `raw` in canonical form: trimmed, any leading `./` and every `.` segment
 * dropped, repeated and trailing slashes removed. Does not validate; call
 * {@link overlapPathError} first. The repo root normalises to `""`.
 */
export function normaliseOverlapPath(raw: string): string {
  return raw.trim().split("/").filter((seg) => seg !== "" && seg !== ".").join("/");
}

/** Whether `a` and `b` name the same path or one is a directory prefix of the other. */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

/**
 * The paths both lists touch: for each overlapping pair, the narrower (longer)
 * of the two, deduplicated and sorted.
 */
export function sharedPaths(a: readonly string[], b: readonly string[]): string[] {
  const out = new Set<string>();
  for (const x of a) {
    for (const y of b) {
      if (pathsOverlap(x, y)) out.add(x.length >= y.length ? x : y);
    }
  }
  return [...out].sort();
}

/**
 * Whether `path` is a shared Markdown doc that never holds work
 * (#clw_01M80QPKHGF99SNVZE66C46TY2): a `.md` file under `docs/`, or an
 * `AGENTS.md` or `README.md` at any depth. Edits to these are mostly appends
 * or separate sections that a rebase resolves cheaply. A directory prefix such
 * as `docs` is not one, since it may cover other files.
 */
export function isSharedDocPath(path: string): boolean {
  if (!path.endsWith(".md")) return false;
  if (path.startsWith("docs/")) return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === "AGENTS.md" || name === "README.md";
}

/** The shared Markdown docs ({@link isSharedDocPath}) among {@link sharedPaths}`(a, b)`: an expected rebase, not a hold. */
export function sharedDocPaths(a: readonly string[], b: readonly string[]): string[] {
  return sharedPaths(a, b).filter(isSharedDocPath);
}

/**
 * `paths` without those the ignore list covers: a path equal to an ignore
 * entry or under one. A path that is a directory containing an ignored entry
 * is kept, since it still names other files.
 */
export function filterIgnoredPaths(paths: readonly string[], ignore: readonly string[]): string[] {
  if (ignore.length === 0) return [...paths];
  return paths.filter((p) => !ignore.some((i) => p === i || p.startsWith(`${i}/`)));
}

/** One step of in-flight work in a repo: a plan step, with or without an open PR. */
export interface InFlightStep {
  issueId: string;
  /** The plan position (1-based); null when unknown. */
  position: number | null;
  /** The open PR implementing the step; null for a step not started yet. */
  prNumber: number | null;
  hasOpenPr: boolean;
  /** The step has an open PR, or its issue has an active implementer job and the step is ready. */
  running: boolean;
  /** Every step it depends on is done (always true for a running step). */
  ready: boolean;
  /** The step's issue is never held: Priority, or its hold was lifted with Start anyway. */
  exempt: boolean;
  /** The issue (or PR) is marked Priority. */
  priority: boolean;
  /** Epoch ms the issue was approved through Plan; null when unknown. */
  planApprovedAtMs: number | null;
  /** The files or directory prefixes the step changes, after the ignore list. */
  paths: readonly string[];
  /**
   * False when the step gives way (Decision 8), is not ready, or is itself
   * held ({@link resolveHolding}): it can still be held, but holds nothing.
   */
  holds: boolean;
}

function nullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * The total order in-flight steps run in (Decision 1): a running step (open
 * PR or active implementer job) first, then Priority, then the earliest
 * `plan_approved_at` (null last), then issue id, plan position and PR number.
 * Negative when `a` runs ahead of `b`.
 */
export function compareInFlightSteps(a: InFlightStep, b: InFlightStep): number {
  if (a.running !== b.running) return a.running ? -1 : 1;
  if (a.priority !== b.priority) return a.priority ? -1 : 1;
  const approved = nullsLast(a.planApprovedAtMs, b.planApprovedAtMs);
  if (approved !== 0) return approved;
  if (a.issueId !== b.issueId) return a.issueId < b.issueId ? -1 : 1;
  const position = nullsLast(a.position, b.position);
  if (position !== 0) return position;
  return nullsLast(a.prNumber, b.prNumber);
}

/** What a holder needs to decide whether it gives way (Decision 8). */
export interface GiveWayInput {
  /** The holder's PR is Problematic or CI-blocked. */
  stalled: boolean;
  /** The holder's issue lifecycle (`blocked` and `backlog` give way). */
  lifecycle: string | null;
  /** Epoch ms the step went in flight: its PR row's `created_at`, else `plan_approved_at`. */
  inFlightSinceMs: number | null;
  nowMs: number;
}

/** Whether a holder stops holding: its PR is stalled, its issue Blocked or in Backlog, or it has been in flight over 48 hours. */
export function givesWay(input: GiveWayInput): boolean {
  if (input.stalled) return true;
  if (input.lifecycle === "blocked" || input.lifecycle === "backlog") return true;
  return input.inFlightSinceMs !== null && input.nowMs - input.inFlightSinceMs > OVERLAP_GIVE_WAY_MS;
}

/** A step ahead of another that shares files with it. */
export interface OverlapHolder {
  step: InFlightStep;
  /** The shared paths ({@link sharedPaths}) that hold: shared Markdown docs left out. */
  shared: string[];
}

function sameStep(a: InFlightStep, b: InFlightStep): boolean {
  return a.issueId === b.issueId && a.position === b.position && a.prNumber === b.prNumber;
}

/**
 * The steps that hold `step`: those earlier in {@link compareInFlightSteps}'s
 * order that still hold and share at least one path with it that is not a
 * shared Markdown doc ({@link isSharedDocPath}), in that order. A step with no
 * paths is never held.
 */
export function holdersAhead(step: InFlightStep, inFlight: readonly InFlightStep[]): OverlapHolder[] {
  if (step.paths.length === 0) return [];
  const out: OverlapHolder[] = [];
  for (const other of inFlight) {
    if (sameStep(other, step) || !other.holds || other.paths.length === 0) continue;
    if (compareInFlightSteps(other, step) >= 0) continue;
    const shared = sharedPaths(other.paths, step.paths).filter((p) => !isSharedDocPath(p));
    if (shared.length > 0) out.push({ step: other, shared });
  }
  return out.sort((a, b) => compareInFlightSteps(a.step, b.step));
}

/**
 * `steps` with `holds` settled (#clw_01M80QPKHGF99SNVZE66C46TY2), so a step
 * is held only by work that is running or can start now. In
 * {@link compareInFlightSteps}'s order, in one pass: a running step keeps its
 * give-way `holds`; a step that is not ready holds nothing; a ready unstarted
 * step keeps its `holds` when its issue is exempt or no earlier step that
 * holds shares a blocking path with it, and holds nothing when one does. A
 * held step never holds, so no two steps wait on each other and no chain
 * forms through a step that cannot start. New objects, in `steps`' order.
 */
export function resolveHolding(steps: readonly InFlightStep[]): InFlightStep[] {
  const resolved = new Map<InFlightStep, InFlightStep>();
  const ahead: InFlightStep[] = [];
  for (const step of [...steps].sort(compareInFlightSteps)) {
    let holds = step.holds;
    if (!step.running) {
      if (!step.ready) holds = false;
      else if (holds && !step.exempt && holdersAhead(step, ahead).length > 0) holds = false;
    }
    const out = { ...step, holds };
    resolved.set(step, out);
    ahead.push(out);
  }
  return steps.map((s) => resolved.get(s)!);
}

/** `paths` as a short list: the first `max`, then "and N more". */
export function formatSharedPaths(paths: readonly string[], max = 3): string {
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown;
}
