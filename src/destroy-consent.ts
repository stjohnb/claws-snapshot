/**
 * Tofu destroy consent captured with the Plan approval
 * (#clw_01M70H3K4B7H0SNSAB5XJ8ZFCJ). The Planner declares, per planned PR, the
 * exact resource addresses it destroys or replaces (`infra_changes`,
 * `src/infra-declaration.ts`); raising an issue's approval through Plan
 * snapshots that set onto `claws_issues.approved_destroys`
 * (`src/issue-approval-write.ts`), and a re-plan or a withdrawal clears it.
 *
 * Claws — never the implementing agent — writes each PR's share of the
 * snapshot into the PR body as a marked block and adds
 * {@link CLAWS_APPROVED_DESTROYS_LABEL}. bstjohn-blog's and production-infra's
 * `assert-no-destroy.sh` then pass a plan only when its destroy/replace set
 * equals the block's addresses, on the PR check and on the push-triggered
 * apply after merge. The block:
 *
 *     <!-- claws-approved-destroys -->
 *     ```tofu-approved-destroys
 *     root: tofu
 *     aws_route53_record.example
 *     ```
 *
 * The guards count a fence only when the previous non-blank line is the
 * marker, and ignore a fence with no closing line (a truncated body).
 */

import * as db from "./db.js";
import * as gh from "./github.js";
import * as log from "./log.js";
import type { ApprovedDestroy, ClawsPrRecord, IssuePlannedPR } from "./db.js";
import type { InfraDeclaration } from "./infra-declaration.js";

export type { ApprovedDestroy } from "./db.js";

/** The PR label bstjohn-blog's destroy guard requires before it reads the block; toggling it re-runs the PR's `Tofu Plan` there. */
export const CLAWS_APPROVED_DESTROYS_LABEL = "claws-approved-destroys";

/** The HTML comment that must sit directly above each `tofu-approved-destroys` fence. */
export const APPROVED_DESTROYS_MARKER = "<!-- claws-approved-destroys -->";

/** The fenced block's info string. */
export const APPROVED_DESTROYS_FENCE = "```tofu-approved-destroys";

/** The heading of the PR body section holding the blocks. */
export const APPROVED_DESTROYS_HEADING = "## Approved destroys";

const SECTION_INTRO = "The operator approved destroying or replacing exactly these resources with the plan;";

/** One root's approved addresses, as a PR body block carries them. */
export interface ApprovedDestroysBlock {
  root: string;
  /** Sorted, de-duplicated. */
  addresses: string[];
}

/**
 * The destroy set of planned PR entries: every declared resource whose actions
 * include `destroy` or `replace`, one item per (position, root, address).
 * Entries without a declaration contribute nothing.
 */
export function destroySetOf(
  entries: readonly { position: number; repo: string; infraChanges?: InfraDeclaration | null }[],
): ApprovedDestroy[] {
  const out: ApprovedDestroy[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    for (const r of e.infraChanges?.resources ?? []) {
      if (!r.actions.includes("destroy") && !r.actions.includes("replace")) continue;
      const key = `${e.position}\u0000${r.root}\u0000${r.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ position: e.position, repo: e.repo, root: r.root, address: r.address });
    }
  }
  return out.sort((a, b) => a.position - b.position || a.root.localeCompare(b.root) || a.address.localeCompare(b.address));
}

function sortedUnique(addresses: readonly string[]): string[] {
  return [...new Set(addresses.map((a) => a.trim()).filter((a) => a !== ""))].sort();
}

/**
 * One root's block: the marker, then the fence with a `root:` line and one
 * address per line. `repo` is accepted for symmetry with the snapshot and to
 * keep the caller's intent explicit; the block itself names only the root,
 * which is what the repo's guard checks.
 */
export function renderApprovedDestroysBlock(_repo: string, root: string, addresses: readonly string[]): string {
  return [APPROVED_DESTROYS_MARKER, APPROVED_DESTROYS_FENCE, `root: ${root}`, ...sortedUnique(addresses), "```"].join("\n");
}

/** The blocks one planned PR carries: its share of `destroys`, grouped by root. */
export function blocksForEntry(destroys: readonly ApprovedDestroy[], position: number, repo: string): ApprovedDestroysBlock[] {
  const byRoot = new Map<string, string[]>();
  for (const d of destroys) {
    if (d.position !== position || d.repo.toLowerCase() !== repo.toLowerCase()) continue;
    byRoot.set(d.root, [...(byRoot.get(d.root) ?? []), d.address]);
  }
  return [...byRoot.entries()]
    .map(([root, addresses]) => ({ root, addresses: sortedUnique(addresses) }))
    .sort((a, b) => a.root.localeCompare(b.root));
}

/**
 * The PR body section for `blocks` — heading, one explanatory line, then one
 * marked block per root — or "" when there is nothing to approve.
 */
export function renderApprovedDestroysSection(repo: string, blocks: readonly ApprovedDestroysBlock[]): string {
  const nonEmpty = blocks.filter((b) => b.addresses.length > 0);
  if (nonEmpty.length === 0) return "";
  return [
    APPROVED_DESTROYS_HEADING,
    "",
    `${SECTION_INTRO} the destroy guard passes only when the plan's destroys equal this list. Claws writes this block — do not edit it.`,
    "",
    nonEmpty.map((b) => renderApprovedDestroysBlock(repo, b.root, b.addresses)).join("\n\n"),
  ].join("\n");
}

/**
 * Every fence-closed marked block in `body`, as the guards read it: CRs
 * stripped, `root:` and blank lines dropped, addresses sorted and
 * de-duplicated. A fence counts only when the previous non-blank line is the
 * marker; a block with no closing fence is left out.
 */
export function extractApprovedDestroysBlock(body: string): ApprovedDestroysBlock[] {
  const lines = body.replace(/\r/g, "").split("\n").map((l) => l.trim());
  const out: ApprovedDestroysBlock[] = [];
  let prev = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === APPROVED_DESTROYS_FENCE && prev === APPROVED_DESTROYS_MARKER) {
      let root = "";
      const addresses: string[] = [];
      let closed = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j]!;
        if (l === "```") { closed = true; break; }
        if (l === "") continue;
        if (l.startsWith("root:")) { root = l.slice(5).trim(); continue; }
        addresses.push(l);
      }
      if (!closed) break;
      if (root) out.push({ root, addresses: sortedUnique(addresses) });
      i = j;
      prev = "";
      continue;
    }
    if (line !== "") prev = line;
  }
  return out.sort((a, b) => a.root.localeCompare(b.root));
}

/**
 * `body` without the approved-destroys section: its heading, its explanatory
 * line, and every marker with the fence under it (closed, or running to the
 * end of a truncated body). The rest of the body is left as it was, with
 * runs of blank lines collapsed and trailing whitespace trimmed.
 */
export function stripApprovedDestroysBlock(body: string): string {
  const lines = body.replace(/\r/g, "").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === APPROVED_DESTROYS_HEADING || t.startsWith(SECTION_INTRO)) continue;
    if (t === APPROVED_DESTROYS_MARKER) {
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === "") j++;
      if (j < lines.length && lines[j]!.trim() === APPROVED_DESTROYS_FENCE) {
        let k = j + 1;
        while (k < lines.length && lines[k]!.trim() !== "```") k++;
        i = k;
      }
      continue;
    }
    kept.push(lines[i]!);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** `body` with its approved-destroys section replaced by `blocks`' (or removed when they are empty). */
export function withApprovedDestroysSection(body: string, repo: string, blocks: readonly ApprovedDestroysBlock[]): string {
  const stripped = stripApprovedDestroysBlock(body);
  const section = renderApprovedDestroysSection(repo, blocks);
  return section ? `${stripped}\n\n${section}` : stripped;
}

function blocksKey(blocks: readonly ApprovedDestroysBlock[]): string {
  return JSON.stringify(blocks.filter((b) => b.addresses.length > 0).map((b) => [b.root, b.addresses]).sort());
}

/** Whether two block lists name the same addresses under the same roots. */
export function sameBlocks(a: readonly ApprovedDestroysBlock[], b: readonly ApprovedDestroysBlock[]): boolean {
  return blocksKey(a) === blocksKey(b);
}

/** The planned entry a PR row belongs to: the entry linked to it, else the one at its phase in its repo. */
function entryForPr(entries: readonly IssuePlannedPR[], repo: string, prNumber: number, phase: number | null): IssuePlannedPR | undefined {
  const sameRepo = (e: IssuePlannedPR) => e.repo.toLowerCase() === repo.toLowerCase();
  return entries.find((e) => sameRepo(e) && e.prNumber === prNumber)
    ?? (phase !== null ? entries.find((e) => sameRepo(e) && e.position === phase && e.prNumber === null) : undefined);
}

/**
 * The blocks PR `repo#prNumber` should carry now: its planned entry's share
 * of the issue's recorded destroy consent. Empty when the PR has no linked
 * issue or planned entry, or when no consent is recorded. `row` is the PR's
 * `claws_prs` row when the caller has already read it; omitted, it is read.
 */
export async function expectedBlocksForPr(repo: string, prNumber: number, row?: ClawsPrRecord | null): Promise<ApprovedDestroysBlock[]> {
  if (row === undefined) row = await db.getClawsPr(repo, prNumber);
  if (!row?.issueId) return [];
  const consent = await db.getApprovedDestroys(row.issueId);
  if (!consent || consent.destroys.length === 0) return [];
  const entry = entryForPr(await db.getIssuePlannedPRs(row.issueId), repo, prNumber, row.phase);
  return entry ? blocksForEntry(consent.destroys, entry.position, entry.repo) : [];
}

async function ensureConsentLabel(repo: string): Promise<void> {
  await gh.ensureLabel(repo, CLAWS_APPROVED_DESTROYS_LABEL, {
    color: "b60205",
    description: "Claws wrote the operator's approved tofu destroy set into the PR body; the destroy guard passes only on an equal plan",
  });
}

/** Add {@link CLAWS_APPROVED_DESTROYS_LABEL} to a PR, creating the label first. */
export async function addConsentLabel(repo: string, prNumber: number): Promise<void> {
  await ensureConsentLabel(repo);
  await gh.addLabel(repo, prNumber, CLAWS_APPROVED_DESTROYS_LABEL);
}

/** Whether a line of `body` is exactly the marker, the only form {@link stripApprovedDestroysBlock} removes. */
function hasMarkerLine(body: string): boolean {
  return body.replace(/\r/g, "").split("\n").some((l) => l.trim() === APPROVED_DESTROYS_MARKER);
}

export type DestroyConsentSync = "unchanged" | "added" | "removed" | "changed";

/**
 * Bring open PR `repo#prNumber`'s body block and label into line with the
 * issue's current destroy consent for its planned entry. When the body's
 * block differs from the expected one the body is rewritten; then the label
 * is added when the expected block is non-empty, removed when it is empty,
 * and removed-then-added when the addresses changed. production-infra's
 * `Tofu Plan` also runs on a body edit; bstjohn-blog's runs only on a label
 * change, so the toggle is what re-plans there. A block nobody approved — one
 * an agent wrote into the body — is always stripped, label or not, since
 * production-infra's guard reads the block without the label.
 *
 * `pr.body`, when given (the PR list carries it), lets a PR with no expected
 * block, no label and no marker in its body return without a body read;
 * `row` is the PR's `claws_prs` row when the caller has read it. Throws on a
 * forge failure; the auto-merger logs it and carries on.
 */
export async function syncPrDestroyConsent(
  repo: string,
  pr: { number: number; labels: readonly { name: string }[]; body?: string },
  row?: ClawsPrRecord | null,
): Promise<DestroyConsentSync> {
  const expected = await expectedBlocksForPr(repo, pr.number, row);
  const hasLabel = pr.labels.some((l) => l.name === CLAWS_APPROVED_DESTROYS_LABEL);
  const want = expected.some((b) => b.addresses.length > 0);
  if (!want && !hasLabel && pr.body !== undefined && !hasMarkerLine(pr.body)) return "unchanged";
  const body = await gh.getPRBody(repo, pr.number);
  const actual = extractApprovedDestroysBlock(body);
  const bodyDiffers = !sameBlocks(actual, expected) || (!want && hasMarkerLine(body));
  if (bodyDiffers) {
    await gh.updatePR(repo, pr.number, withApprovedDestroysSection(body, repo, expected));
  }
  let result: DestroyConsentSync = "unchanged";
  if (want) {
    if (hasLabel && bodyDiffers) {
      await gh.removeLabel(repo, pr.number, CLAWS_APPROVED_DESTROYS_LABEL);
      await addConsentLabel(repo, pr.number);
      result = "changed";
    } else if (!hasLabel) {
      await addConsentLabel(repo, pr.number);
      result = "added";
    }
  } else if (hasLabel) {
    await gh.removeLabel(repo, pr.number, CLAWS_APPROVED_DESTROYS_LABEL);
    result = "removed";
  } else if (bodyDiffers) {
    // An unapproved block stripped from a PR without the label.
    result = "removed";
  }
  if (result !== "unchanged") {
    const count = expected.reduce((n, b) => n + b.addresses.length, 0);
    log.info("synced approved destroys on PR", { component: "destroy-consent", repo, pr: pr.number, outcome: result, addresses: count });
  }
  return result;
}

/**
 * Push issue `trackerId`'s current destroy consent out to each of its open PRs
 * (and to `also`, PRs a re-plan just unlinked from it) with
 * {@link syncPrDestroyConsent}, right after the consent is recorded,
 * withdrawn or cleared by a re-plan. A withdrawal must not wait for a merge
 * sweep, which skips a held PR. Best-effort per PR: a failure is logged and
 * the auto-merger's sweep retries it.
 */
export async function syncIssuePrsDestroyConsent(
  trackerId: string,
  also: readonly { repo: string; prNumber: number | null }[] = [],
): Promise<void> {
  let rows: { repo: string; prNumber: number | null }[];
  try {
    rows = [...await db.listOpenClawsPrsForIssueOrSteps(trackerId), ...also];
  } catch (err) {
    log.warn("could not list the issue's open PRs to sync approved destroys", { component: "destroy-consent", trackerId }, err);
    return;
  }
  const seen = new Set<string>();
  for (const { repo, prNumber } of rows) {
    if (prNumber === null) continue;
    const key = `${repo.toLowerCase()}#${prNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const live = await gh.getPRMergeGate(repo, prNumber);
      if (live.state !== "OPEN") continue;
      await syncPrDestroyConsent(repo, { number: prNumber, labels: live.labels.map((name) => ({ name })) });
    } catch (err) {
      log.warn("could not sync approved destroys on PR", { component: "destroy-consent", trackerId, repo, pr: prNumber }, err);
    }
  }
}

/** What the approval track's `.destroy-consent` block shows. */
export type DestroyConsentState = "pending" | "given" | "withdrawn";

/** The approval track's view of an issue's declared destroys and the consent recorded for them. */
export interface DestroyConsentView {
  /** The current plan's declared destroys and replaces. */
  destroys: ApprovedDestroy[];
  state: DestroyConsentState;
  /** Who gave the consent and when (`YYYY-MM-DD HH:MM:SS` UTC), when `given`. */
  consent: { by: string; at: string } | null;
}

/**
 * The view for an issue whose plan declares `entries`, approved through
 * Plan or not (`planApproved`), with `consent` recorded. Undefined when the
 * plan declares no destroy: the track shows no block. Consent given covers
 * the plan only when it still names the declared set; consent cleared by a
 * re-plan while the approval stayed reads as withdrawn.
 */
export function destroyConsentView(
  entries: readonly { position: number; repo: string; infraChanges?: InfraDeclaration | null }[],
  planApproved: boolean,
  consent: db.IssueApprovedDestroys | null,
): DestroyConsentView | undefined {
  const destroys = destroySetOf(entries);
  if (destroys.length === 0) return undefined;
  if (planApproved && consent) return { destroys, state: "given", consent: { by: consent.by, at: consent.at } };
  return { destroys, state: planApproved ? "withdrawn" : "pending", consent: null };
}
