/**
 * Disposable issue previews: candidate output (3d-models' renders) a planner
 * makes visible to a maintainer while a plan is under review, either as a
 * draft PR a repository opens or — for a repository that pushes only a
 * `claws/preview-issue-<issue ref>` branch and deploys a summary JSON, never
 * opening a PR — as that branch alone.
 *
 * The contract with a repository is the head branch name alone —
 * `claws/preview-issue-<issue ref>` — never a PR-body cross-reference: preview
 * PRs deliberately avoid `#<issue>` so they are never read as the issue's
 * implementation PR. What Claws last mirrored lives in a marker line on the
 * issue's `## Preview` comment, which is edited in place.
 *
 * Used by `jobs/issue-preview-sync.ts` on its timer and by the planner right
 * after it posts or edits a plan.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { LABELS, prUrl, getIssuePreviewSummaryUrl, isForgejoRepo } from "./config.js";
import * as gh from "./github.js";
import * as log from "./log.js";
import { canonicalIssueRef, parseIssueRef, type IssueRef } from "./issue-id.js";
import { issueRefAliases, resolveImportedRef } from "./imported-refs-index.js";
import { resolveTrackerId } from "./planned-prs.js";
import * as db from "./db.js";

export const PREVIEW_BRANCH_PREFIX = "claws/preview-issue-";
/** Must never contain `## Implementation Plan`: plan lookups key on that header. */
export const PREVIEW_HEADER = "## Preview";
export const PREVIEW_MARKER = "CLAWS_ISSUE_PREVIEW:";
/** Copied results are cut here, with a pointer to the PR for the rest. */
export const MAX_RESULTS_CHARS = 20_000;

/** The issue a `claws/preview-issue-<ref>` branch belongs to, or null. */
export function issueRefFromPreviewBranch(branch: string): IssueRef | null {
  if (!branch.toLowerCase().startsWith(PREVIEW_BRANCH_PREFIX)) return null;
  return parseIssueRef(branch.slice(PREVIEW_BRANCH_PREFIX.length));
}

/** The branch name a repository's preview step pushes for `ref`. */
export function previewBranchFor(ref: IssueRef): string {
  return `${PREVIEW_BRANCH_PREFIX}${canonicalIssueRef(ref) ?? ref}`;
}

/**
 * The open preview PR for `ref` in `repo`, or null. Matches every spelling of
 * the issue (an imported forge issue keeps its old number as an alias), and the
 * id case-insensitively. Fork PRs never count.
 */
export async function findIssuePreviewPR(repo: string, ref: IssueRef): Promise<gh.PR | null> {
  const wanted = new Set(issueRefAliases(repo, ref).map((r) => String(r).toLowerCase()));
  const prs = await gh.listPRs(repo);
  for (const pr of prs) {
    if (gh.isForkPR(pr)) continue;
    const branchRef = issueRefFromPreviewBranch(pr.headRefName);
    if (branchRef !== null && wanted.has(String(branchRef).toLowerCase())) return pr;
  }
  return null;
}

/** An issue's preview: a legacy draft PR, or — when the repo has no open PR — its bare branch. */
export type IssuePreview =
  | { kind: "pr"; pr: gh.PR }
  | { kind: "branch"; branch: string; headSha: string };

/**
 * The issue's preview in `repo`: an open non-fork PR wins over a bare branch.
 * Falls back to a `claws/preview-issue-<ref>` branch with no open PR only when
 * `repo`'s `claws.json` sets `issuePreviewSummaryUrl` and `repo` is on GitHub
 * (the branch path reads git-data, which has no Forgejo equivalent here).
 */
export async function findIssuePreview(repo: string, ref: IssueRef): Promise<IssuePreview | null> {
  const pr = await findIssuePreviewPR(repo, ref);
  if (pr) return { kind: "pr", pr };

  const template = getIssuePreviewSummaryUrl(repo);
  if (!template) return null;
  if (isForgejoRepo(repo)) {
    log.warn(`[issue-previews] ${repo} sets issuePreviewSummaryUrl but is on Forgejo — PR-less previews are GitHub-only`);
    return null;
  }

  const wanted = new Set(issueRefAliases(repo, ref).map((r) => String(r).toLowerCase()));
  const branches = await gh.listBranchesByPrefix(repo, PREVIEW_BRANCH_PREFIX);
  for (const b of branches) {
    const branchRef = issueRefFromPreviewBranch(b.name);
    if (branchRef !== null && wanted.has(String(branchRef).toLowerCase())) {
      return { kind: "branch", branch: b.name, headSha: b.sha };
    }
  }
  return null;
}

/**
 * The summary JSON URL for a preview branch's head, from `repo`'s
 * `issuePreviewSummaryUrl` template. `{issue}` is the branch suffix verbatim
 * (not canonicalised — the repository's CI derives its S3 prefix from the ref
 * name it pushed, not from Claws' notion of the canonical id); `{sha8}` is the
 * head's first 8 hex characters.
 */
export function previewSummaryUrl(template: string, branch: string, headSha: string): string {
  const issueId = branch.slice(PREVIEW_BRANCH_PREFIX.length);
  return template.replaceAll("{issue}", issueId).replaceAll("{sha8}", headSha.slice(0, 8));
}

const PreviewSummarySchema = z.object({ markdown: z.string(), viewer_url: z.string().optional() }).passthrough();

export interface PreviewSummary {
  markdown: string;
  viewerUrl: string | undefined;
}

/**
 * Fetch a preview branch's summary JSON. Null means the render for that exact
 * head has not landed yet (404) — since the URL embeds the head, that is never
 * ambiguous with a stale render. Any other non-2xx status or an unparsable
 * body throws, for the caller to report and retry next tick.
 */
export async function fetchPreviewSummary(url: string): Promise<PreviewSummary | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching preview summary from ${url}`);
  const parsed = PreviewSummarySchema.parse(await res.json());
  return { markdown: parsed.markdown, viewerUrl: parsed.viewer_url };
}

const REFRESH_RULE = (id: string, branch: string): string =>
  `Refresh rule: if your revised plan changes anything the preview shows (dimensions, features, parameters, which files), write the candidate files and re-run the repository's preview step with the issue id \`${id}\` exactly (for 3d-models: \`scripts/request-issue-preview.sh ${id} <files>\`; if the script rejects the id, perform its steps by hand: same branch, force-push a commit built on origin/main). Before re-running: \`git fetch origin ${branch}\` then \`git diff origin/${branch} -- <files>\`; an empty diff means do not re-run, because re-pushing an unchanged tree still triggers a full render. A change to plan prose alone never re-runs it. In the plan's Decisions, name the preview head the plan corresponds to, or say why the preview was not refreshed.`;

/** The planner prompt section telling the agent the preview exists and when to refresh it. */
export function buildPreviewPromptSection(repo: string, preview: IssuePreview, headSha: string, ref: IssueRef): string {
  const id = String(canonicalIssueRef(ref) ?? ref);
  const branch = previewBranchFor(ref);
  if (preview.kind === "pr") {
    return [
      `## Issue preview`,
      `This issue has a disposable preview: PR ${repo}#${preview.pr.number} on branch \`${branch}\` at head \`${headSha}\`. It is a draft labelled ${LABELS.clawsIgnore}, is not the implementation PR, and must never be referenced with \`#\` from the plan or a PR body. Claws mirrors its render results onto this issue in a \`${PREVIEW_HEADER}\` comment and closes it when the plan is approved or the issue is closed: do not close it yourself and do not wait for its build.`,
      REFRESH_RULE(id, branch),
    ].join("\n");
  }
  return [
    `## Issue preview`,
    `This issue has a disposable preview: branch \`${branch}\` at head \`${headSha}\`, with no PR open for it. Claws mirrors its render results onto this issue in a \`${PREVIEW_HEADER}\` comment and deletes the branch when the plan is approved or the issue is closed: do not post the render summary yourself, do not run the repository's \`--cleanup\` step, and do not delete the branch.`,
    REFRESH_RULE(id, branch),
  ].join("\n");
}

// ── Marker ──

export interface PreviewMarker {
  repo: string;
  /** null for a PR-less branch preview. */
  pr: number | null;
  head: string;
  /** 12-hex sha256 of the copied results body, or `none`. */
  results: string;
  status: "current" | "retired";
}

export function formatPreviewMarker(m: PreviewMarker): string {
  return `${PREVIEW_MARKER} repo=${m.repo} pr=${m.pr ?? "none"} head=${m.head} results=${m.results} status=${m.status}`;
}

const MARKER_RE = new RegExp(
  `${PREVIEW_MARKER}\\s*repo=(\\S+)\\s+pr=(\\d+|none)\\s+head=(\\S+)\\s+results=([0-9a-f]{12}|none)\\s+status=(current|retired)`,
);

export function parsePreviewMarker(body: string): PreviewMarker | null {
  const m = body.match(MARKER_RE);
  if (!m) return null;
  return { repo: m[1]!, pr: m[2] === "none" ? null : Number(m[2]), head: m[3]!, results: m[4]!, status: m[5] as PreviewMarker["status"] };
}

function sameMarker(a: PreviewMarker, b: PreviewMarker): boolean {
  return a.repo.toLowerCase() === b.repo.toLowerCase()
    && a.pr === b.pr && a.head === b.head && a.results === b.results && a.status === b.status;
}

function resultsHash(body: string | null): string {
  return body === null ? "none" : createHash("sha256").update(body).digest("hex").slice(0, 12);
}

// ── Bodies ──

/**
 * The newest comment on the preview PR posted by a CI bot (`…[bot]` or
 * `github-actions`) that is not Claws' own — the repository's render results.
 */
export function selectResultsComment(comments: gh.IssueComment[], selfLogin: string): gh.IssueComment | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (gh.isClawsComment(c.body)) continue;
    if (c.login === selfLogin) continue;
    if (c.login.endsWith("[bot]") || c.login === "github-actions") return c;
  }
  return null;
}

export interface PreviewBodyInput {
  repo: string;
  /** null for a PR-less branch preview. */
  pr: number | null;
  headSha: string;
  /** The preview's head branch. */
  branch: string;
  /** The copied PR results comment, or the branch's fetched summary markdown; null when neither exists yet. */
  results: string | null;
  /** Branch preview only: link to the rendered viewer, used when results are present. */
  viewerUrl?: string;
  /** Set when the preview was retired; `reason` names why. */
  retired?: { reason: "refined" | "closed"; at: Date; resultsHash: string };
}

export function buildPreviewBody(input: PreviewBodyInput): string {
  const sha7 = input.headSha.slice(0, 7);
  if (input.pr === null) return buildBranchPreviewBody(input, sha7);

  const pr = input.pr;
  const url = prUrl(input.repo, pr);
  if (input.retired) {
    const why = input.retired.reason === "closed" ? "the issue was closed" : `the issue was approved (${LABELS.refined})`;
    return [
      PREVIEW_HEADER,
      ``,
      `Retired on ${input.retired.at.toISOString()}: preview PR [\`${input.repo}#${pr}\`](${url}) was closed because ${why}. Its rendered artifacts are reclaimed by the repository's cleanup workflow. Last previewed head: \`${sha7}\`.`,
      ``,
      formatPreviewMarker({ repo: input.repo, pr, head: input.headSha, results: input.retired.resultsHash, status: "retired" }),
    ].join("\n");
  }
  const lines = [
    PREVIEW_HEADER,
    ``,
    `Preview PR [\`${input.repo}#${pr}\`](${url}) (branch \`${input.branch}\`, head \`${sha7}\`).`,
    ``,
  ];
  if (input.results === null) {
    lines.push(`No results have been posted on the PR yet; the render for head \`${sha7}\` is pending.`);
  } else {
    lines.push(input.results.includes(sha7)
      ? `Results below are for head \`${sha7}\`.`
      : `The results below predate head \`${sha7}\`; its render is pending.`);
    lines.push(``, `---`, ``);
    lines.push(input.results.length > MAX_RESULTS_CHARS
      ? `${input.results.slice(0, MAX_RESULTS_CHARS)}\n\n…(truncated; see the full results on [the PR](${url}))`
      : input.results);
    lines.push(``, `---`);
  }
  lines.push(``, formatPreviewMarker({ repo: input.repo, pr, head: input.headSha, results: resultsHash(input.results), status: "current" }));
  return lines.join("\n");
}

/** The bare-branch variant of {@link buildPreviewBody} — no open PR, so no PR link and no staleness check (the summary URL already embeds the exact head). */
function buildBranchPreviewBody(input: PreviewBodyInput, sha7: string): string {
  if (input.retired) {
    const why = input.retired.reason === "closed" ? "the issue was closed" : `the issue was approved (${LABELS.refined})`;
    return [
      PREVIEW_HEADER,
      ``,
      `Retired on ${input.retired.at.toISOString()}: preview branch \`${input.branch}\` was deleted because ${why}. Its rendered artifacts are reclaimed by the repository's cleanup workflow. Last previewed head: \`${sha7}\`.`,
      ``,
      formatPreviewMarker({ repo: input.repo, pr: null, head: input.headSha, results: input.retired.resultsHash, status: "retired" }),
    ].join("\n");
  }
  const lines = [
    PREVIEW_HEADER,
    ``,
    `Preview branch \`${input.branch}\` (head \`${sha7}\`); no PR is open for it.`,
    ``,
  ];
  if (input.results === null) {
    lines.push(`No results found for head \`${sha7}\` yet — the render is pending, or the build failed; check the branch's workflow runs.`);
  } else {
    const viewerLink = input.viewerUrl ? ` [View the render](${input.viewerUrl}).` : "";
    lines.push(`Results below are for head \`${sha7}\`.${viewerLink}`, ``, `---`, ``);
    lines.push(input.results.length > MAX_RESULTS_CHARS
      ? `${input.results.slice(0, MAX_RESULTS_CHARS)}\n\n…(truncated${input.viewerUrl ? `; see the full results on [the viewer](${input.viewerUrl})` : ""})`
      : input.results);
    lines.push(``, `---`);
  }
  lines.push(``, formatPreviewMarker({ repo: input.repo, pr: null, head: input.headSha, results: resultsHash(input.results), status: "current" }));
  return lines.join("\n");
}

// ── Sync ──

/** `repos` without case-insensitive repeats, first spelling and order kept. */
export function uniqueRepos(repos: readonly string[]): string[] {
  const seen = new Set<string>();
  return repos.filter((r) => !seen.has(r.toLowerCase()) && !!seen.add(r.toLowerCase()));
}

/** The issue's existing `## Preview` comment for `repo`'s preview, if any. */
function findPreviewComment(comments: gh.IssueComment[], repo: string): { comment: gh.IssueComment; marker: PreviewMarker } | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (!gh.isClawsComment(c.body) || !c.body.includes(PREVIEW_HEADER)) continue;
    const marker = parsePreviewMarker(c.body);
    if (marker && marker.repo.toLowerCase() === repo.toLowerCase()) return { comment: c, marker };
  }
  return null;
}

/**
 * Bring the issue's `## Preview` comment in line with `preview` in `repo`,
 * retiring it — closing the PR, or deleting the branch — when the issue is
 * closed or `Refined`. Writes nothing when the marker already says what this
 * pass would write, so a steady preview costs reads only. Issues in
 * `Backlog` or `Claws Ignore` are left untouched.
 *
 * The comment is posted as the Planner, so it is a Claws comment and never
 * reads as feedback that would trigger another refine.
 */
export async function syncIssuePreview(repo: string, branchRef: IssueRef, preview: IssuePreview): Promise<void> {
  // A forge issue imported into the native tracker is closed on the forge;
  // the native issue it became is the one whose state and thread count.
  const ref = resolveImportedRef(repo, branchRef);
  let state: Awaited<ReturnType<typeof gh.getIssueState>>;
  try {
    state = await gh.getIssueState(repo, ref);
  } catch (err) {
    log.warn(`[issue-previews] ${repo}#${ref}: could not read the issue for its preview (${err})`);
    return;
  }
  if (state.labels.includes(LABELS.backlog) || state.labels.includes(LABELS.clawsIgnore)) return;

  const comments = await gh.getIssueComments(repo, ref);
  const existing = findPreviewComment(comments, repo);
  const write = async (body: string): Promise<void> => {
    if (existing) await gh.editIssueComment(repo, existing.comment.id, body, { agentName: "Planner" });
    else await gh.commentOnIssue(repo, ref, body, { agentName: "Planner" });
  };

  // `Refined` is short-lived: issue-worker removes it as soon as it opens the
  // PR, which then has an open `claws_prs` row. Catching either means
  // retirement doesn't depend on the sync tick landing inside that window.
  const closed = state.state === "CLOSED";
  const refined = state.labels.includes(LABELS.refined);
  const trackerId = refined || closed ? null : await resolveTrackerId(repo, ref);
  const planDecided = refined || (!!trackerId && (await db.listOpenClawsPrsForIssue(trackerId)).length > 0);

  if (preview.kind === "pr") {
    const { pr } = preview;
    if (closed || planDecided) {
      const headSha = await gh.getPRHeadSHA(repo, pr.number);
      const alreadyRetired = existing?.marker.status === "retired" && existing.marker.pr === pr.number && existing.marker.head === headSha;
      if (!alreadyRetired) {
        await write(buildPreviewBody({
          repo, pr: pr.number, headSha, branch: pr.headRefName, results: null,
          retired: { reason: closed ? "closed" : "refined", at: new Date(), resultsHash: existing?.marker.results ?? "none" },
        }));
      }
      // Written before closing: if the close below fails, the record already
      // reflects retirement and the PR is retried closed on the next tick
      // without writing again.
      await gh.closePR(repo, pr.number);
      const trigger = closed ? "closed" : refined ? LABELS.refined : "open PR";
      log.info(`[issue-previews] Retired preview PR ${repo}#${pr.number} for issue ${ref} (${trigger})`);
      return;
    }

    const [headSha, prComments, selfLogin] = await Promise.all([
      gh.getPRHeadSHA(repo, pr.number),
      gh.getIssueComments(repo, pr.number),
      gh.getSelfLoginForRepo(repo),
    ]);
    const results = selectResultsComment(prComments, selfLogin)?.body ?? null;
    const next: PreviewMarker = { repo, pr: pr.number, head: headSha, results: resultsHash(results), status: "current" };
    if (existing && sameMarker(existing.marker, next)) return;
    await write(buildPreviewBody({ repo, pr: pr.number, headSha, branch: pr.headRefName, results }));
    return;
  }

  const { branch, headSha } = preview;
  if (closed || planDecided) {
    const alreadyRetired = existing?.marker.status === "retired" && existing.marker.pr === null && existing.marker.head === headSha;
    if (!alreadyRetired) {
      await write(buildPreviewBody({
        repo, pr: null, headSha, branch, results: null,
        retired: { reason: closed ? "closed" : "refined", at: new Date(), resultsHash: existing?.marker.results ?? "none" },
      }));
    }
    // Written before deleting, for the same retry-without-rewrite reason as the PR path.
    try {
      await gh.deleteRemoteBranch(repo, branch);
    } catch (err) {
      if (!gh.isRefAlreadyGone(err)) throw err;
    }
    const trigger = closed ? "closed" : refined ? LABELS.refined : "open claws_prs row";
    log.info(`[issue-previews] Retired preview branch ${repo}:${branch} for issue ${ref} (${trigger})`);
    return;
  }

  const template = getIssuePreviewSummaryUrl(repo);
  const summary = template ? await fetchPreviewSummary(previewSummaryUrl(template, branch, headSha)) : null;
  const results = summary?.markdown ?? null;
  const next: PreviewMarker = { repo, pr: null, head: headSha, results: resultsHash(results), status: "current" };
  if (existing && sameMarker(existing.marker, next)) return;
  await write(buildPreviewBody({ repo, pr: null, headSha, branch, results, viewerUrl: summary?.viewerUrl }));
}

/**
 * Sync every preview for `ref` across `repo` and `repos` — the planner's call right after
 * it posts or edits a plan. Failures are logged per repo and never thrown.
 */
export async function syncPreviewsForIssue(repo: string, ref: IssueRef, repos: readonly string[]): Promise<void> {
  for (const r of uniqueRepos([repo, ...repos])) {
    try {
      const preview = await findIssuePreview(r, ref);
      if (preview) await syncIssuePreview(r, ref, preview);
    } catch (err) {
      log.warn(`[issue-previews] ${r}: could not sync the preview for issue ${ref} (${err})`);
    }
  }
}
