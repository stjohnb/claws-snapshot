/**
 * The PR↔issue relation Claws records on its own `claws_prs` row
 * (#clw_01M7FC1ARKV7AYR9C0EGC26S8F): which issue a PR belongs to, whether
 * merging it finishes that issue (`closes`) or is one step of several
 * (`part-of`), the plan's step count, and any other issues it closes.
 *
 * The row is the source of truth; the PR body's `Closes` / `Part of` lines
 * and `## PR N of M:` header are display, rebuilt from the row. Body and title
 * parsing decide only for a PR whose row records no relation (hand-opened,
 * pre-change, imported).
 *
 * - For the issue the row names, only `issue_relation` decides closes vs step.
 * - Other issues stay additive: a ref in `also_closes` closes, and a body
 *   `Closes #…` naming an issue the row does not record is still honoured.
 *
 * Must not import `planned-prs.ts` or `issue-handback.ts` (both read it).
 */

import * as db from "./db.js";
import * as gh from "./github.js";
import * as log from "./log.js";
import { issueRefAliases } from "./imported-refs.js";
import { ISSUE_REF_PATTERN, isClawsIssueId, sameIssueRef, type IssueRef } from "./issue-id.js";

const ISSUE_BRANCH_RE = new RegExp(`^claws/issue-(${ISSUE_REF_PATTERN})-`);

export type PrIssueRelation = db.ClawsPrIssueRelation;

/**
 * The tracker (`claws_issues`) id of an issue ref: a native id is its own, a
 * forge number resolves through its import or shadow link. Null when none.
 */
export async function trackerIdFor(repo: string, ref: IssueRef): Promise<string | null> {
  if (isClawsIssueId(ref)) return ref;
  return (await db.getLinkedNativeId(repo, ref)) ?? null;
}

/** What {@link recordPrIssueRelation} writes. `issueRef` is the ref the body line names. */
export interface PrIssueRelationInput {
  relation: PrIssueRelation;
  issueRef: IssueRef;
  issueId?: string | null;
  phase?: number | null;
  planSteps?: number | null;
  alsoCloses?: readonly IssueRef[] | null;
}

/**
 * Upsert the PR's relation to its issue onto its `claws_prs` row and log it.
 * Only the keys given are written; `alsoCloses` undefined leaves the column alone.
 */
export async function recordPrIssueRelation(prRepo: string, prNumber: number, input: PrIssueRelationInput): Promise<void> {
  const alsoCloses = input.alsoCloses === undefined || input.alsoCloses === null
    ? input.alsoCloses
    : [...new Set(input.alsoCloses.map(String))].filter((r) => !sameIssueRef(r, input.issueRef));
  await db.upsertClawsPr(prRepo, prNumber, {
    issueRelation: input.relation,
    issueRef: String(input.issueRef),
    ...(input.issueId !== undefined ? { issueId: input.issueId } : {}),
    ...(input.phase !== undefined ? { phase: input.phase } : {}),
    ...(input.planSteps !== undefined ? { planSteps: input.planSteps } : {}),
    ...(alsoCloses !== undefined ? { alsoCloses: alsoCloses && alsoCloses.length > 0 ? alsoCloses : null } : {}),
  });
  log.info("[pr-issue-relation] Recorded PR issue relation", {
    repo: prRepo,
    pr: prNumber,
    relation: input.relation,
    issueRef: String(input.issueRef),
    phase: input.phase ?? null,
    planSteps: input.planSteps ?? null,
    alsoCloses: alsoCloses ?? null,
  });
}

/**
 * The relation to record for a PR Claws did not record one for at creation
 * (a backfill, or a resumed lost attempt): a PR on the issue's own
 * `claws/issue-<ref>-` branch whose stored plan has exactly one entry is
 * `closes` regardless of its body; otherwise `closes` when its body closes the
 * issue (`bodyCloses`, the caller's `closesIssue` over the issue's aliases),
 * else `part-of`.
 */
export function inferPrIssueRelation(opts: {
  headRefName: string;
  issueRepo: string;
  issueRef: IssueRef;
  storedEntries: number | null;
  bodyCloses: boolean;
}): PrIssueRelation {
  const branchRef = opts.headRefName.match(ISSUE_BRANCH_RE)?.[1] ?? null;
  const ownBranch = branchRef !== null
    && issueRefAliases(opts.issueRepo, opts.issueRef).some((alias) => sameIssueRef(branchRef, alias));
  if (ownBranch && opts.storedEntries === 1) return "closes";
  return opts.bodyCloses ? "closes" : "part-of";
}

/**
 * Add `ref` to the PR's `also_closes`: merging it closes that issue too (a
 * target-PR push from another issue whose keyword is `Closes`). A no-op when
 * the row already closes `ref`, as its own issue or in `also_closes`.
 */
export async function addPrAlsoCloses(prRepo: string, prNumber: number, ref: IssueRef): Promise<void> {
  const row = await db.getClawsPr(prRepo, prNumber);
  if (row && storedClosedRefs(row).some((r) => sameIssueRef(r, ref))) return;
  const next = [...(row?.alsoCloses ?? []), String(ref)];
  await db.upsertClawsPr(prRepo, prNumber, { alsoCloses: next });
  log.info("[pr-issue-relation] Recorded an extra issue the PR closes", { repo: prRepo, pr: prNumber, issueRef: String(ref) });
}

/** Whether `rowRef` names the issue `issueRepo#issueRef` (or its tracker id). */
function namesIssue(
  row: Pick<db.ClawsPrRecord, "repo">,
  rowRef: string,
  issueRepo: string,
  issueRef: IssueRef,
  trackerId: string | null,
): boolean {
  if (trackerId && sameIssueRef(rowRef, trackerId)) return true;
  // A forge number names an issue only in its own repo; a native id is global.
  if (!isClawsIssueId(rowRef) && row.repo !== issueRepo) return false;
  return issueRefAliases(issueRepo, issueRef).some((alias) => sameIssueRef(rowRef, alias));
}

/**
 * What the row records about `issueRepo#issueRef`: `closes` when its own
 * issue relation is `closes` or `also_closes` holds the ref, `part-of` when it
 * names the issue as a step, null when the row records nothing about it (the
 * caller then falls back to the body). `trackerId` widens the match to the
 * issue's native id, for a forge issue with a shadow.
 */
export function storedRelationFor(
  row: db.ClawsPrRecord | null | undefined,
  issueRepo: string,
  issueRef: IssueRef,
  trackerId: string | null = null,
): PrIssueRelation | null {
  if (!row) return null;
  if (row.issueRelation) {
    const own = [row.issueRef, row.issueId].filter((r): r is string => !!r);
    if (own.some((r) => namesIssue(row, r, issueRepo, issueRef, trackerId))) return row.issueRelation;
  }
  if ((row.alsoCloses ?? []).some((r) => namesIssue(row, r, issueRepo, issueRef, trackerId))) return "closes";
  return null;
}

/** Every issue ref the row records the PR as closing: its own when `closes`, then `also_closes`. */
export function storedClosedRefs(row: db.ClawsPrRecord | null | undefined): string[] {
  if (!row) return [];
  const out: string[] = [];
  if (row.issueRelation === "closes" && row.issueRef) out.push(row.issueRef);
  for (const r of row.alsoCloses ?? []) if (!out.some((o) => sameIssueRef(o, r))) out.push(r);
  return out;
}

/**
 * The `Closes` / `Part of` lines a PR body ends with, rebuilt from the row.
 * Built from `issue_ref`, never `issue_id`: a forge issue's `issue_id` is its
 * shadow's `clw_…` id, which the forge knows nothing about. Empty when the row
 * records no relation.
 */
export function closingLinesFor(row: db.ClawsPrRecord | null | undefined): string[] {
  if (!row?.issueRelation || !row.issueRef) return [];
  const lines = [`${row.issueRelation === "closes" ? "Closes" : "Part of"} #${row.issueRef}`];
  for (const r of row.alsoCloses ?? []) {
    if (!sameIssueRef(r, row.issueRef)) lines.push(`Closes #${r}`);
  }
  return lines;
}

/** A merged PR as the single-step settle reads it. `repo` defaults to the issue's repo. */
export interface MergedPRForRelation {
  number: number;
  body?: string;
  mergedAt?: string;
  repo?: string;
  closes?: boolean;
}

/**
 * Annotate merged PRs with what their rows record about the issue: `closes`
 * is set (true or false) on each PR whose row records a relation, left
 * undefined otherwise so the body decides. Then append merged PRs, in any
 * repo, whose row records that they close the issue but which are missing
 * from the list (another repo, or a body that lost the ref), with
 * `closes: true` and the forge's merge time (skipped when that is
 * unreadable). Best-effort: a failed read returns the list unchanged, so
 * the body fallback still decides.
 */
export async function withStoredRelations<T extends { number: number; body?: string; mergedAt?: string; repo?: string }>(
  issueRepo: string,
  issueRef: IssueRef,
  mergedPRs: readonly T[],
): Promise<Array<(T & { closes?: boolean }) | MergedPRForRelation>> {
  try {
    const trackerId = await trackerIdFor(issueRepo, issueRef);
    const out: Array<(T & { closes?: boolean }) | MergedPRForRelation> = [];
    for (const pr of mergedPRs) {
      const row = await db.getClawsPr(pr.repo ?? issueRepo, pr.number);
      const rel = storedRelationFor(row, issueRepo, issueRef, trackerId);
      out.push(rel === null ? pr : { ...pr, closes: rel === "closes" });
    }
    const closers = await db.listMergedClawsPrsClosingIssue(trackerId, String(issueRef));
    for (const row of closers) {
      if (storedRelationFor(row, issueRepo, issueRef, trackerId) !== "closes") continue;
      const present = out.some((pr) => pr.number === row.prNumber && (pr.repo ?? issueRepo) === row.repo);
      if (present) continue;
      // The real merge time, for the reopened-after-merge check: the row's
      // `updated_at` moves on later writes to a merged row, so it could read
      // as later than a human's reopen. Unreadable → skip the row, leaving the
      // decision to the PRs already listed (which parks rather than closes).
      const mergedAt = await gh.getUpstreamPRStatus(row.repo, row.prNumber)
        .then((s) => s?.mergedAt ?? null)
        .catch((err) => {
          log.warn("[pr-issue-relation] Could not read a recorded closer's merge time — skipping it", { repo: row.repo, pr: row.prNumber }, err);
          return null;
        });
      if (mergedAt === null) continue;
      out.push({
        number: row.prNumber,
        ...(row.repo !== issueRepo ? { repo: row.repo } : {}),
        body: "",
        mergedAt,
        closes: true,
      });
    }
    return out;
  } catch (err) {
    log.warn("[pr-issue-relation] Could not read stored PR relations — falling back to PR bodies", { repo: issueRepo, issueRef: String(issueRef) }, err);
    return [...mergedPRs];
  }
}
