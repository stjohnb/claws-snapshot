/**
 * Move one repository's open forge issues into the Claws-native tracker
 * (#3215).
 *
 * New issues are always filed natively; this job carries the existing forge
 * backlog across and keeps carrying whatever is filed on a forge afterwards.
 * It runs on a timer (`intervals.issueImporterMs`); each run walks every
 * repository and imports whatever is not mid-flight, so an issue skipped for
 * an open PR or queued work is picked up by a later run without anyone
 * triggering anything. The dashboard `Run` button does the same walk.
 *
 * See docs/jobs/issue-importer.md and docs/issue-tracker.md.
 */

import {
  ALLOWED_ACTORS,
  LABELS,
  forgeIssueUrl,
  forgejoRepoUrl,
  getMainBuildIgnoreWorkflows,
  isJobDisabledForRepo,
  type Repo,
} from "../config.js";
import * as gh from "../github.js";
import * as clawsIssues from "../claws-issues.js";
import * as db from "../db.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { mapSettledWithConcurrency } from "../util.js";
import { referencesIssue } from "../phase-coverage.js";
import { loadIssuePhaseState, peekTotalPhases } from "../planned-prs.js";
import * as planParser from "../plan-parser.js";
import { sameIssueRef, type IssueRef } from "../issue-id.js";
import { ISSUE_SCOPED_KINDS } from "../worker.js";
import { PLAN_HEADER, hasStepBackReconsiderMarker, issueContentHash, parsePlanBodyHash, planMarkersFor, stripPlanMarkers } from "../agents/issue-refiner.js";
import { approvedRequirementsOrNull, loadApprovedRequirements } from "../approved-requirements.js";
import { recordImport, resolveImportedRef } from "../imported-refs.js";
import * as forgejo from "../forgejo.js";
import { extractAttachmentUrls, extractImageUrls, fetchIssueFile } from "../images.js";
import { attachmentUrl, deleteIssueAttachment, storeIssueAttachment, MAX_UPLOAD_BYTES } from "../issue-attachments.js";

const NAME = "issue-importer";

/**
 * Why each forge issue was last left on the forge, keyed by
 * {@link holdKey}. Display-only — the board's "Waiting for import" chip and
 * the per-repo summary line read it; no guard does. In-memory, so a restart
 * forgets it until the next pass refills it.
 */
const importHolds = new Map<string, string>();

function holdKey(repo: string, issueNumber: IssueRef): string {
  return `${repo}\u0000${issueNumber}`;
}

function holdIssue(repo: string, issueNumber: IssueRef, reason: string): void {
  importHolds.set(holdKey(repo, issueNumber), reason);
}

/** Why the last pass left `repo#issueNumber` on the forge, if it did. */
export function importHoldReason(repo: string, issueNumber: IssueRef): string | undefined {
  return importHolds.get(holdKey(repo, issueNumber));
}

function holdsFor(repo: string): string[] {
  const prefix = `${repo}\u0000`;
  return [...importHolds].filter(([key]) => key.startsWith(prefix))
    .map(([key, reason]) => `#${key.slice(prefix.length)}: ${reason}`);
}

/**
 * How many work-queue rows the mid-flight guard reads.
 *
 * `listQueuedWork`'s 200-row default is fleet-wide and ordered by status and
 * priority, so on a busy fleet a low-priority `queued` row for this repository
 * can sort past it — and a guard that silently stops seeing the row it exists
 * to see would close a forge issue whose implementer is about to open a PR
 * against it.
 */
const QUEUE_SCAN_LIMIT = 10_000;

/** Reaction reads in flight while copying one issue's comment thread. */
const REACTION_CONCURRENCY = 6;

/**
 * Listing passes over one repository per run.
 *
 * A GitHub listing is a single 100-issue page, so a big backlog needs several;
 * the cap only bounds a run against a listing that keeps reporting truncation.
 */
const MAX_LISTING_PASSES = 10;

/** Files copied into the native store per imported issue (decision 11 of #3289). */
const MAX_COPIED_FILES = 50;

/** Largest file copied into the native store; the same cap as a dashboard upload. */
const MAX_COPIED_FILE_BYTES = MAX_UPLOAD_BYTES;

/** Image types whose stored name needs an extension for the pipeline to treat them as images. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export interface ImportResult {
  repo: string;
  imported: number;
  failed: number;
  /** Issues a mid-flight guard caught between the candidate filter and the write. */
  skipped: number;
}

export interface ImportableIssues {
  issues: gh.Issue[];
  /** The forge listing hit its page cap, so more issues may remain unseen. */
  truncated: boolean;
  /** CI-runner issues duplicating a `main-build-monitor` issue; `run` closes them. */
  duplicates: CiDuplicate[];
}

/** A forge issue duplicating `main-build-monitor`'s `Build failure: <workflow>` issue. */
export interface CiDuplicate {
  issue: gh.Issue;
  workflow: string;
}

/** The work-queue and open-PR state a mid-flight check is decided against. */
interface MidFlightState {
  queued: readonly { repo: string; kind: string; item_number: IssueRef; status: string }[];
  prs: readonly { number: number; title: string; body?: string }[];
  openPR: { number: number } | null;
}

/**
 * Why `issueNumber` must not be imported right now, or null.
 *
 * Both halves are "an agent is already working this issue under its forge
 * number": a `queued`/`running` row is the widest window (the implementer may
 * not have pushed a branch yet), and an open PR referencing the issue is the
 * visible one. `referencesIssue` rather than `closesIssue` — a phase PR's body
 * says `Part of #<N>`, and its title carries `#<N>`, so the closing keyword
 * alone misses every hand-rolled multi-phase PR.
 */
function midFlightBlocker(repo: string, issueNumber: IssueRef, state: MidFlightState): string | null {
  const work = state.queued.find(
    (row) => row.repo === repo && ISSUE_SCOPED_KINDS.has(row.kind) && sameIssueRef(row.item_number, issueNumber),
  );
  if (work) return `${work.kind} is ${work.status} for it`;
  const pr = state.openPR
    ?? state.prs.find((p) => referencesIssue({ title: p.title ?? "", body: p.body ?? "" }, issueNumber));
  if (pr) return `open PR #${pr.number} still references it`;
  return null;
}

/** A completed default-branch run, as either forge's listing reports it. */
interface DefaultBranchRun {
  /** The number the run's web URL carries. */
  urlNumber: number | null;
  workflowName: string;
  /** `main-build-monitor` only files an issue for `failure`. */
  conclusion: string | null;
}

/**
 * The repository's completed default-branch runs, keyed the way the run's web
 * URL numbers them: Forgejo's `/actions/runs/<n>` carries the per-repo run
 * number, GitHub's carries the run id.
 */
async function loadDefaultBranchRuns(repo: Repo): Promise<DefaultBranchRun[]> {
  if (repo.forge === "forgejo") {
    const rows = await forgejo.listDefaultBranchActionRuns(repo.fullName, repo.defaultBranch);
    return rows.map((r) => ({ urlNumber: r.run_number, workflowName: r.workflow_name, conclusion: r.conclusion }));
  }
  const rows = await db.getDefaultBranchRuns(repo.fullName, repo.defaultBranch, 7);
  return rows.map((r) => ({ urlNumber: r.run_id, workflowName: r.workflow_name, conclusion: r.conclusion }));
}

/** The run number a CI-runner issue's body links to on `repo`, or null. */
function linkedRunNumber(repo: Repo, body: string): number | null {
  const base = repo.forge === "forgejo" ? forgejoRepoUrl(repo.fullName) : `https://github.com/${repo.fullName}`;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}/actions/runs/(\\d+)`).exec(body);
  return match ? Number(match[1]) : null;
}

/** What to do with a bot-authored forge issue instead of importing it. */
type BotVerdict =
  | { kind: "import" }
  | { kind: "skip"; reason: string }
  | { kind: "close-duplicate"; workflow: string };

/**
 * Whether a bot-authored forge issue must not be imported.
 *
 * Two bot sources file issues that would only ever cost a requirements and
 * planning pass ending in "no code change" (#clw_01M4RW0TECEKTFT6ZY6GS18DH3):
 * - a dependency bot's tracking issue (Renovate's Dependency Dashboard) is
 *   left on the forge untouched. Closing it is wrong — Renovate re-creates it;
 * - a CI runner's failure issue linking a `failure` default-branch run of a
 *   workflow `main-build-monitor` tracks duplicates the monitor's own
 *   `Build failure: <workflow>` issue. This only classifies it; `run` closes it.
 *
 * Every other CI-runner issue imports as before. A run-listing failure skips
 * the issue for this run rather than importing a likely duplicate.
 * `runs` loads the listing at most once per call of `importableIssues`.
 */
async function botVerdict(
  repo: Repo,
  issue: gh.Issue,
  runs: () => Promise<DefaultBranchRun[]>,
): Promise<BotVerdict> {
  if (gh.isDependencyBotAuthor(issue)) return { kind: "skip", reason: "dependency-bot tracking issue, never imported" };
  if (!gh.isCiAlertBotAuthor(issue, repo.fullName)) return { kind: "import" };
  if (isJobDisabledForRepo("main-build-monitor", repo.fullName)) return { kind: "import" };
  const runNumber = linkedRunNumber(repo, issue.body ?? "");
  if (runNumber === null) return { kind: "import" };

  let listed: DefaultBranchRun[];
  try {
    listed = await runs();
  } catch (err) {
    log.warn(`[${NAME}] Could not list ${repo.fullName}'s default-branch runs to check ${repo.fullName}#${issue.number} against main-build-monitor: ${err}`);
    return { kind: "skip", reason: "could not check it against main-build-monitor; retrying on a later run" };
  }
  const run = listed.find((r) => r.urlNumber === runNumber);
  if (!run || run.conclusion !== "failure" || getMainBuildIgnoreWorkflows(repo.fullName).includes(run.workflowName)) {
    return { kind: "import" };
  }
  return { kind: "close-duplicate", workflow: run.workflowName };
}

/** Close a forge issue that duplicates `main-build-monitor`'s tracking issue; true on success. */
async function closeCiDuplicate(repo: Repo, { issue, workflow }: CiDuplicate): Promise<boolean> {
  try {
    await gh.commentOnIssue(
      repo.fullName,
      issue.number,
      `Closed by Claws: this failed \`${repo.defaultBranch}\` run is tracked by \`main-build-monitor\` as \`Build failure: ${workflow}\`, so this duplicate is not imported.`,
      { agentName: NAME },
    );
    await gh.closeIssue(repo.fullName, issue.number, "not_planned");
    log.info(`[${NAME}] Closed ${repo.fullName}#${issue.number} on the forge — duplicates main-build-monitor's "Build failure: ${workflow}" issue`);
    return true;
  } catch (err) {
    log.warn(`[${NAME}] Could not close duplicate CI issue ${repo.fullName}#${issue.number}: ${err}`);
    return false;
  }
}

/**
 * The issues of `repo` this job would move, in the forge's own order.
 *
 * Five exclusions, each for a different reason:
 * - a native issue is already in the tracker — `gh.listOpenIssues` unions both
 *   backends, so the list it returns is not all forge issues;
 * - an issue `imported_issues` already has a row for. `importIssue` closes the
 *   forge issue last, so a failure after the native create leaves the forge
 *   issue open with the native one already written — and every later run
 *   lists the same repository again, which would otherwise import it a second
 *   time. The row is the only idempotency key: it commits in the same
 *   transaction as the native row, so there is no window it does not answer
 *   in. The `Imported from <url>` body prefix stays in the body as a
 *   human-readable pointer back to the forge, not as a fallback key;
 * - a bot-authored issue that needs no plan (see `botVerdict`): a
 *   dependency bot's tracking issue, or a CI runner's failure issue that
 *   duplicates `main-build-monitor`;
 * - an issue with an open PR referencing it is mid-flight. Closing the issue
 *   underneath the PR leaves the native issue with no PR linkage, so nothing
 *   closes it when that PR merges;
 * - an issue with a `queued` or `running` work-queue row is mid-flight too,
 *   and the widest window of it: the implementer may not have pushed a branch
 *   yet, so there is no PR to see.
 *
 * `Claws Ignore` is not an exclusion. It means automation must not plan or
 * implement the issue, not that the issue must stay on the forge, so an
 * ignored issue is imported like any other and the label travels with it: the
 * native copy keeps it, and the dispatchers keep leaving it alone.
 *
 * An issue an upstream watch targets is no longer excluded: `imported_issues`
 * makes the manifest's `issue: <N>` keep resolving, so `processWatch` acts on
 * the native issue (#3245).
 *
 * The last two are a *candidate filter only*. They are read once per repository
 * while `importRepo` then walks a whole backlog one slow issue at a time, with
 * `issue-dispatcher` still running on its own timer throughout, so `importIssue`
 * re-reads them immediately before its first write — this snapshot is minutes
 * old by the time the last issue of a big repository is reached.
 *
 * `truncated` is carried out to `run`: the GitHub listing is a single
 * 100-issue page, so `run` lists the same repository again after importing
 * one rather than moving on and stranding the rest of its backlog.
 */
export async function importableIssues(target: Repo): Promise<ImportableIssues> {
  const repo = target.fullName;
  const open = await gh.listOpenIssues(repo, { includeImported: true });
  const prefix = `${repo}\u0000`;
  for (const key of importHolds.keys()) if (key.startsWith(prefix)) importHolds.delete(key);
  const truncated = gh.openIssuesMayBeTruncated(repo, open);
  const candidates = open.filter((issue) => !gh.isNativeIssue(issue.number));
  // `run` walks the whole fleet every run, so a repository with no candidates
  // must cost nothing beyond the listing it already did.
  if (candidates.length === 0) return { issues: [], truncated, duplicates: [] };

  const [prs, queued] = await Promise.all([
    gh.listPRs(repo),
    db.listQueuedWork(QUEUE_SCAN_LIMIT),
  ]);

  let runsListing: Promise<DefaultBranchRun[]> | null = null;
  const runs = () => (runsListing ??= loadDefaultBranchRuns(target));

  const issues: gh.Issue[] = [];
  const duplicates: CiDuplicate[] = [];
  for (const issue of candidates) {
    // A shadow has an `imported_issues` row too, and its forge issue is still
    // a candidate: `listImportedIssues` excludes shadows from the alias index,
    // so `resolveImportedRef` leaves the forge number as it is here and the
    // issue falls through to `importIssue`, which promotes that shadow in
    // place rather than creating a second native issue (#3246).
    const nativeId = resolveImportedRef(repo, issue.number);
    const recorded = !sameIssueRef(nativeId, issue.number);
    // A native issue still carrying the guard label is a half-finished
    // import, not a finished one: `importIssue` creates it ignored and
    // un-ignores it last, so the difference is the operator's signal that
    // this one needs reconciling rather than simply skipping. An id the
    // `open` listing does not name at all is a finished one — the native
    // issue has since been closed. A forge issue that is still open with a
    // row is unfinished either way, since the forge close is the last step —
    // but when the forge issue carried `Claws Ignore` itself the label is
    // meant to stay, so the operator is not told to remove it.
    if (recorded) {
      const already = open.find((n) => sameIssueRef(n.number, nativeId));
      const forgeIgnored = issue.labels.some((l) => l.name === LABELS.clawsIgnore);
      if (already?.labels.some((l) => l.name === LABELS.clawsIgnore) && forgeIgnored) {
        log.warn(`[${NAME}] Skipping ${repo}#${issue.number} — it was imported as ${already.number} but that import did not finish. Check it on /issues, then close the forge issue by hand`);
        holdIssue(repo, issue.number, `imported as ${already.number} but that import did not finish`);
      } else if (already?.labels.some((l) => l.name === LABELS.clawsIgnore)) {
        log.warn(`[${NAME}] Skipping ${repo}#${issue.number} — it was imported as ${already.number} but that import did not finish: the native issue still carries "${LABELS.clawsIgnore}". Finish it on /issues, remove the label, then close the forge issue by hand`);
        holdIssue(repo, issue.number, `imported as ${already.number} but that import did not finish`);
      } else {
        log.info(`[${NAME}] Skipping ${repo}#${issue.number} — already imported into the native tracker`);
        holdIssue(repo, issue.number, `already imported as ${nativeId}`);
      }
      continue;
    }
    const bot = await botVerdict(target, issue, runs);
    if (bot.kind === "skip") {
      log.info(`[${NAME}] Skipping ${repo}#${issue.number} — ${bot.reason}`);
      holdIssue(repo, issue.number, bot.reason);
      continue;
    }
    const blocker = midFlightBlocker(repo, issue.number, {
      queued,
      prs,
      openPR: await gh.getOpenPRForIssue(repo, issue.number),
    });
    if (blocker) {
      log.info(`[${NAME}] Skipping ${repo}#${issue.number} — ${blocker}`);
      holdIssue(repo, issue.number, blocker);
      continue;
    }
    // Only once nothing is mid-flight: closing the forge issue under a queued
    // agent or an open PR is what the blocker exists to prevent.
    if (bot.kind === "close-duplicate") {
      duplicates.push({ issue, workflow: bot.workflow });
      continue;
    }
    issues.push(issue);
  }
  return { issues, truncated, duplicates };
}

/**
 * The exact prefix `importedBody` writes: a human-readable pointer back to
 * the forge, not an idempotency key — `imported_issues` is that, and it
 * commits in the same transaction as the native row.
 */
export function importedFromPrefix(forgeUrl: string): string {
  return `Imported from ${forgeUrl} (opened by @`;
}

/** The body a native issue carries: a pointer back to the forge, then the original. */
export function importedBody(forgeUrl: string, authorLogin: string, body: string): string {
  return `${importedFromPrefix(forgeUrl)}${authorLogin})\n\n${body}`.trimEnd();
}

/** A file one text links to, found by the prompt pipeline's own extractors. */
interface ForgeFile {
  url: string;
  name: string;
  /** Found by the image extractor, so a download that is not an image is not a copy of it. */
  image?: boolean;
}

/** The copy budget shared by the body and every comment of one issue. */
interface FileCopyState {
  remaining: number;
  /** Rows written, so a promotion that loses its race can take them back. */
  stored: string[];
  /** Forge URL → native URL, so a file two texts link is copied once. */
  copied: Map<string, string>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches every link to `file` in a text. A Forgejo attachment is matched on
 * its UUID, because the forge's editor inserts site-relative links
 * (`/attachments/<uuid>` or `/<owner>/<repo>/attachments/<uuid>`) rather than
 * the absolute `browser_download_url` the API lists. Anything else is matched
 * on its URL, raw or HTML-escaped as an `<img src>` carries it, and only
 * where the URL ends — so `…/x.png` never rewrites the head of
 * `…/x.png?raw=true`, whichever of the two was copied.
 */
function linkPattern(file: ForgeFile): RegExp {
  const uuid = forgejo.attachmentUuid(file.url);
  if (uuid) {
    const origin = escapeRegExp(new URL(file.url).origin);
    return new RegExp(`(?:${origin})?(?:/[^/\\s()"'<>]+/[^/\\s()"'<>]+)?/attachments/${escapeRegExp(uuid)}`, "gi");
  }
  const spellings = file.url.includes("&") ? [file.url, file.url.replace(/&/g, "&amp;")] : [file.url];
  return new RegExp(`(?:${spellings.map(escapeRegExp).join("|")})(?=[\\s)"'<>\\]]|$)`, "g");
}

function fileNameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
    // fall through
  }
  return "attachment";
}

/**
 * The files `text` links to: markdown and `<img>` images, GitHub
 * `user-attachments` links, and any listed forge asset (Forgejo keeps uploads
 * in an `assets` field, not in recognisable text) the text links to. Assets
 * come first, so an absolute link to one keeps the asset's name and is not
 * picked up a second time as an image.
 */
function forgeFilesIn(text: string, assets: readonly ForgeFile[]): ForgeFile[] {
  const linked = assets.filter((asset) => linkPattern(asset).test(text));
  const files: ForgeFile[] = [...linked];
  const add = (url: string, name: string, image = false) => {
    if (files.some((f) => f.url === url) || linked.some((a) => linkPattern(a).test(url))) return;
    files.push({ url, name, image });
  };
  for (const img of extractImageUrls(text, "markdown")) {
    if (!img.url.startsWith("data:")) add(img.url, fileNameFromUrl(img.url), true);
  }
  for (const att of extractAttachmentUrls(text)) add(att.url, att.filename);
  return files;
}

/** What {@link copyForgeFiles} made of one text. */
interface CopiedText {
  /** The text with each copied URL replaced by its native relative one. */
  text: string;
  /** The attachments this call stored — not ones an earlier text already copied. */
  attachmentIds: string[];
}

/**
 * Copy the files `text` links to into the native store under `issueId` and
 * rewrite each copied URL to its native relative one, so the imported issue
 * keeps its screenshots and uploads after the forge copy is closed.
 *
 * Best-effort by design: a failed download or store leaves the original URL
 * in place and logs a warning, and never fails the import. `extra` carries
 * files that belong to this text without appearing in it (Forgejo assets no
 * comment links, attributed to the body).
 */
async function copyForgeFiles(
  repo: string,
  issueId: string,
  text: string,
  uploader: string,
  state: FileCopyState,
  assets: readonly ForgeFile[],
  extra: readonly ForgeFile[] = [],
): Promise<CopiedText> {
  const files = forgeFilesIn(text, assets);
  for (const file of extra) if (!files.some((f) => f.url === file.url)) files.push(file);
  const rewrites: { file: ForgeFile; nativeUrl: string }[] = [];
  const attachmentIds: string[] = [];
  for (const file of files) {
    const already = state.copied.get(file.url);
    if (already) {
      rewrites.push({ file, nativeUrl: already });
      continue;
    }
    if (state.remaining <= 0) {
      log.warn(`[${NAME}] ${repo} → ${issueId}: file copy limit of ${MAX_COPIED_FILES} reached; leaving ${file.url} on the forge`);
      continue;
    }
    state.remaining--;
    const fetched = await fetchIssueFile(file.url, repo, MAX_COPIED_FILE_BYTES);
    if ("error" in fetched) {
      log.warn(`[${NAME}] ${repo} → ${issueId}: could not copy ${file.url}: ${fetched.error}`);
      continue;
    }
    const type = fetched.contentType.split(";")[0]!.trim().toLowerCase();
    if (file.image && !type.startsWith("image/")) {
      // A login or interstitial page answering an image URL: storing it would
      // swap a link that may still work for a broken image.
      log.warn(`[${NAME}] ${repo} → ${issueId}: ${file.url} returned ${type || "no content type"}, not an image; leaving it on the forge`);
      continue;
    }
    const ext = IMAGE_EXTENSIONS[type];
    const name = ext && !/\.(png|jpe?g|gif|webp)$/i.test(file.name) ? `${file.name}${ext}` : file.name;
    const stored = await storeIssueAttachment(issueId, name, fetched.buffer, fetched.contentType, uploader);
    if (!stored.ok) {
      log.warn(`[${NAME}] ${repo} → ${issueId}: could not store ${file.url}: ${stored.reason}`);
      continue;
    }
    state.stored.push(stored.row.id);
    attachmentIds.push(stored.row.id);
    const nativeUrl = attachmentUrl(stored.row);
    state.copied.set(file.url, nativeUrl);
    rewrites.push({ file, nativeUrl });
  }
  let out = text;
  for (const { file, nativeUrl } of rewrites) out = out.replace(linkPattern(file), () => nativeUrl);
  return { text: out, attachmentIds };
}

interface CopiedComment {
  /** The body as posted (forge text with copied file URLs rewritten) — what the plan lookup matches on. */
  body: string;
  nativeId: string;
}

/**
 * Why this issue must not be imported *now*, re-read against live state, or
 * null.
 *
 * `importableIssues` filters a whole repository's backlog against one snapshot
 * and `importRepo` then spends minutes walking it, while `issue-dispatcher`
 * keeps enqueueing on its own timer — so a batch-level guard cannot protect a
 * per-issue irreversible write, and this runs immediately before the first one.
 * The PR list is invalidated first: its 60 s cache is exactly the window a
 * just-opened PR hides in.
 *
 * Purely about timing, and therefore self-clearing: a `claws-duplicate-of:`
 * marker on another issue used to be refused here too, but `imported_issues`
 * keeps the forge number resolving, so `gh.listDuplicateIssuesOf` finds those
 * markers under the native id and there is nothing left to re-point (#3245).
 */
async function importBlocker(repo: string, issue: gh.Issue): Promise<string | null> {
  gh.invalidatePRList(repo);
  const [queued, prs, openPR] = await Promise.all([
    db.listQueuedWork(QUEUE_SCAN_LIMIT),
    gh.listPRs(repo),
    gh.getOpenPRForIssue(repo, issue.number),
  ]);
  return midFlightBlocker(repo, issue.number, { queued, prs, openPR });
}

/**
 * Import one forge issue, returning the native id — or null when a guard caught
 * it mid-flight and a later run should pick it up.
 *
 * Every read happens before the first native write, so a failing read cannot
 * leave a half-written native issue behind; the row is created as a shadow,
 * which no list read returns, and becomes a visible issue already carrying
 * `Claws Ignore` in `promoteShadowIssue`'s single transaction, un-ignored only
 * once the whole thread, the phase claim and the plan re-stamp have landed,
 * so a failure in between leaves an issue no dispatcher will pick up rather
 * than one whose plan still points at the forge. A forge issue that carried
 * `Claws Ignore` itself keeps it on the native copy — the label travels with
 * the issue. The forge issue is closed
 * `not_planned` rather than `completed`:
 * nothing was implemented, and `completed` is what the merger and the auditor
 * write when something was.
 */
async function importIssue(repo: string, issue: gh.Issue, selfLogin: string): Promise<string | null> {
  // Reactions are read up front: the insert loop has to stay sequential for
  // ordering, and a per-comment read inside it would make the whole import one
  // serial round trip per comment. A reaction read that fails costs that
  // comment's reactions, not the import — the native issue would otherwise be
  // created and then abandoned by the first transient 403 out of N reads.
  const comments = await gh.getIssueComments(repo, issue.number);
  const settled = await mapSettledWithConcurrency(
    comments,
    REACTION_CONCURRENCY,
    (comment) => gh.getCommentReactions(repo, comment.id),
  );
  const reactions = new Map(comments.map((comment, i) => {
    const result = settled[i];
    if (result.status === "rejected") {
      log.warn(`[${NAME}] Could not read reactions on ${repo}#${issue.number} comment ${comment.id}: ${result.reason}`);
      return [comment.id, [] as gh.Reaction[]] as const;
    }
    return [comment.id, result.value] as const;
  }));

  const blocker = await importBlocker(repo, issue);
  if (blocker) {
    log.info(`[${NAME}] Skipping ${repo}#${issue.number} — ${blocker}`);
    holdIssue(repo, issue.number, blocker);
    return null;
  }

  // Forgejo keeps uploads in an `assets` field rather than in recognisable
  // body text; a failed listing costs those files, not the import. Read after the
  // guard so a skipped issue does not page through its comments every run.
  let assets: ForgeFile[] = [];
  try {
    assets = await gh.getIssueAttachments(repo, issue.number);
  } catch (err) {
    log.warn(`[${NAME}] Could not list attachments on ${repo}#${issue.number}: ${err}`);
  }

  const forgeIgnored = issue.labels.some((l) => l.name === LABELS.clawsIgnore);
  const labels = [...new Set([...issue.labels.map((l) => l.name), LABELS.clawsIgnore])];
  // Every open forge issue normally already has a *shadow* (#3246) — a hidden
  // native row `jobs/issue-shadow-sync.ts` keeps in step with it — so this
  // call usually just resolves it (`created: false`) and the promotion below
  // keeps the `clw_` id, the linkage row and anything else already hanging
  // off it. When there is no shadow yet (the sync job has not reached it),
  // the same call *creates* the linked row atomically, linkage row first, so
  // it is the `(repo, forge_number)` primary key — not an ordering of awaits
  // — that arbitrates against a concurrent `issue-shadow-sync` write. That is
  // why this path can no longer leave a native issue nothing links to.
  //
  // `undefined` means the linkage row already names an *imported* issue — a
  // human reopening an imported forge issue puts it back in the open listing
  // permanently — which is a skip, not a second import.
  //
  // Read here rather than once per run: the sync job mints shadows on its own
  // timer while this walks a backlog one slow issue at a time, so a batch
  // snapshot would miss a shadow created since — and the miss is the silent
  // direction, since `promoteShadowIssue`'s guard never runs at all. This sits
  // immediately after the other mid-flight guards and *is* the first native
  // write, so a guard that fires costs nothing.
  const shadow = await db.createShadowIssue(repo, issue.number, {
    title: issue.title,
    body: issue.body,
    authorLogin: issue.author.login,
    labels: issue.labels.map((l) => l.name),
  });
  if (!shadow) {
    log.info(`[${NAME}] Skipping ${repo}#${issue.number} — its linkage row already names an imported native issue`);
    return null;
  }

  // The body's files are copied before the promotion so the body it writes
  // already links the native copies. A Forgejo asset no comment links is
  // attributed to the body; one a comment links is copied with that comment.
  const files: FileCopyState = { remaining: MAX_COPIED_FILES, stored: [], copied: new Map() };
  const unlinkedAssets = assets.filter((a) => !comments.some((c) => linkPattern(a).test(c.body)));
  const takeBackFiles = async () => {
    for (const attachmentId of files.stored) await deleteIssueAttachment(attachmentId);
  };
  let body: string;
  let promoted: boolean;
  try {
    // A shadow never owns attachments — its routes 404 and nothing uploads to
    // it — so any it has are copies an import that died mid-download left
    // behind. Clearing them first keeps a re-run from listing each file twice.
    for (const row of await db.listClawsIssueAttachments(shadow.id)) await deleteIssueAttachment(row.id);
    const forgeBody = await copyForgeFiles(repo, shadow.id, issue.body, issue.author.login, files, assets, unlinkedAssets);
    body = importedBody(forgeIssueUrl(repo, issue.number), issue.author.login, forgeBody.text);
    // The downloads above can take minutes — long enough for the dispatcher
    // to enqueue work on the forge issue since the first check — so the
    // guard is re-read right before the write it protects.
    const lateBlocker = await importBlocker(repo, issue);
    if (lateBlocker) {
      await takeBackFiles();
      log.info(`[${NAME}] Skipping ${repo}#${issue.number} — ${lateBlocker}`);
      holdIssue(repo, issue.number, lateBlocker);
      return null;
    }
    promoted = await db.promoteShadowIssue(shadow.id, { title: issue.title, body, labels });
  } catch (err) {
    // The shadow stays a shadow, so the next run copies every file onto it
    // again; without this the promoted issue would list each one twice.
    await takeBackFiles();
    throw err;
  }

  // A shadow that is no longer one lost a race with a concurrent import.
  // Bailing out leaves the import the other run produced intact, and the
  // next run skips this issue on its `imported_issues` row rather than
  // copying the whole thread onto it a second time — so the files copied
  // above are taken back too.
  if (!promoted) {
    await takeBackFiles();
    log.info(`[${NAME}] Skipping ${repo}#${issue.number} — its shadow ${shadow.id} was imported by a concurrent run`);
    return null;
  }
  const id = shadow.id;

  // Both paths above arrive here with the linkage row already committed
  // naming `id` — `createShadowIssue` wrote it, whether this call or an
  // earlier `issue-shadow-sync` cycle created the shadow — so this call
  // exists to populate the in-process alias index in `imported-refs.ts`, and
  // its `false` branch is a defensive assertion rather than a reachable race.
  if (!await recordImport(repo, issue.number, id)) {
    throw new Error(`${repo}#${issue.number} is already linked to another native issue; ${id} was left orphaned`);
  }

  // Comments are copied one at a time and in order: `listClawsIssueComments`
  // orders by id, and ids are monotonic, so sequential inserts preserve the
  // thread. Author logins are carried across verbatim — Claws' own comments
  // keep the `*— Automated by Claws —*` marker `issue-refiner` reads to tell
  // its own plans from the human feedback it has to address.
  //
  // None of them announces itself. Replaying a whole backlog's threads one
  // event at a time would evict the 500-slot ring and take every
  // `claws_wait_for_change` waiter's backlog with it; the guard label's removal
  // below is the import's single event, and unlike "the last comment" it fires
  // exactly once per issue however many comments the thread had, and only once
  // the issue is actually ready to be worked.
  //
  // Each comment's files are copied just before it is posted, so the body
  // `commentOnIssue` stores links the native copies and stamps their
  // `comment_id` — only the ones copied for that comment, so a reply linking
  // a file the body already copied leaves it with the body.
  const copied: CopiedComment[] = [];
  for (const comment of comments) {
    const commentFiles = await copyForgeFiles(repo, id, comment.body, comment.login, files, assets);
    const nativeId = await clawsIssues.commentOnIssue(repo, id, commentFiles.text, comment.login, {
      emitEvent: false,
      attachmentIds: commentFiles.attachmentIds,
    });
    if (!nativeId) continue;
    copied.push({ body: commentFiles.text, nativeId });
    await copyReactions(reactions.get(comment.id) ?? [], nativeId, selfLogin);
  }

  // The claim is pushed onto `copied` so the plan's re-stamped fence names it
  // rather than the comment before it — a comment newer than the fence reads as
  // unaddressed post-plan feedback and would strip `Refined`.
  const claimId = await carryPhaseCoverage(repo, issue, id, comments);
  if (claimId) copied.push({ body: "", nativeId: claimId });
  await restampPlan(repo, id, { title: issue.title, body }, issue.body, copied);

  // For an issue that was ignored on the forge the label stays, so the import's
  // single dashboard event is the forge `issue-closed` below rather than the
  // label removal — fine, since an ignored issue is not work any waiter acts on.
  if (forgeIgnored) {
    log.info(`[${NAME}] Keeping "${LABELS.clawsIgnore}" on ${id} — ${repo}#${issue.number} carried it on the forge`);
  } else {
    await clawsIssues.removeLabel(repo, id, LABELS.clawsIgnore);
  }
  await gh.commentOnIssue(repo, issue.number, `Moved to ${clawsIssues.dashboardIssueUrl(id)}`);
  await gh.closeIssue(repo, issue.number, "not_planned");
  // Baselines `forge_synced_at` so `issue-shadow-sync`'s `forwardImportedUpdate`
  // treats a later reopen or edit as new input rather than as another NULL
  // baseline read — without this, the first reopen after the import above is
  // silently swallowed (#3395).
  await db.setImportedForgeSyncedAt(repo, issue.number, new Date().toISOString());
  importHolds.delete(holdKey(repo, issue.number));
  return id;
}

/**
 * Carry Claws' own reactions across as `claws` reactions.
 *
 * Only the forge bot's are copied. A reaction from Claws is *state* — the
 * refiner marks feedback addressed with one, and losing it would make it
 * re-address every comment on the imported issue — whereas a human's 👍 is
 * decoration the native store has no UI for.
 */
async function copyReactions(reactions: readonly gh.Reaction[], nativeCommentId: string, selfLogin: string): Promise<void> {
  for (const reaction of reactions) {
    if (gh.normalizeBotLogin(reaction.user.login) !== selfLogin) continue;
    await clawsIssues.addReaction(nativeCommentId, clawsIssues.CLAWS_NATIVE_LOGIN, reaction.content);
  }
}

/**
 * Re-stamp the imported plan's markers against the issue it now lives on.
 *
 * A plan comment is not inert text: it carries the hash of the title+body it
 * was written against and the id of the newest comment the plan run had seen.
 * Both are keyed to the forge issue, and the import invalidates both — the
 * body gains the `Imported from …` prefix, so the hash no longer matches and
 * `isPlanStaleForIssue` demands a re-plan; and the comment fence still names a
 * forge number, which `compareIssueRefs` orders *below* every `clwc_…` id, so
 * every copied comment would read as unaddressed post-plan feedback and strip
 * `Refined`. Re-stamping against the native content and the last copied
 * comment is what makes an accepted plan actually survive the move.
 *
 * The hash also covers the native issue's approved requirements record, when
 * it has one, so the restamp agrees with the dispatcher's stale-plan check.
 * A failed read is never folded into "no record" — that would restamp a
 * record-covering plan body-only and cost a needless re-plan on the very next
 * dispatcher tick — so the restamp is skipped and the existing (already known
 * stale, from the "Imported from …" prefix above) stamp is left in place;
 * the next tick's successful read plans it once, correctly.
 *
 * A plan whose stamped hash doesn't exactly match what `content`+`forgeBody`
 * would hash to against the *current* record — written before the record
 * existed, against an earlier record version, or body-only against a forge
 * body since edited — must stay (or become) body-only rather than being
 * silently upgraded: there is no way to tell whether its text was ever
 * rewritten against the current record, and guessing "current" would make an
 * un-rewritten plan (still carrying a `### Requirement` section and no
 * version citation) look upgraded and never be retried, exactly what
 * `issue-refiner`'s own re-stamp guards against for the "neither hash
 * matches" case. Stamping body-only is always safe here: it leaves the plan
 * stale, so the next dispatcher tick re-plans it once against the record.
 * `forgeBody` is the issue's body as it stood on the forge — the same content
 * the plan's original hash was stamped against — since `content.body` already
 * carries the "Imported from …" prefix that this restamp introduces and would
 * never match it.
 */
async function restampPlan(repo: string, id: string, content: { title: string; body: string }, forgeBody: string, copied: readonly CopiedComment[]): Promise<void> {
  const planIdx = copied.findLastIndex((c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body));
  if (planIdx === -1) return;
  const requirementsResult = await loadApprovedRequirements(repo, id);
  if (requirementsResult.status === "error") {
    log.warn(`[${NAME}] Could not read the approved requirements for ${repo}#${id} while restamping its imported plan — leaving the existing stamp in place`);
    return;
  }
  const requirements = approvedRequirementsOrNull(requirementsResult);
  const plan = copied[planIdx];
  const fence = copied[copied.length - 1].nativeId;
  const currentRecordHash = requirements !== null ? issueContentHash(content.title, forgeBody, requirements) : null;
  const restampRequirements = requirements !== null && parsePlanBodyHash(plan.body) === currentRecordHash ? requirements : null;
  // `stripPlanMarkers` drops the step-back marker along with the hash and the
  // fence, so it has to be re-emitted: the dispatcher reads it to withhold
  // auto-refine until a human has looked at a plan the planner itself said to
  // reconsider, and losing it hands the issue straight to the implementer.
  await clawsIssues.editIssueComment(
    plan.nativeId,
    `${stripPlanMarkers(plan.body)}${planMarkersFor({ ...content, requirements: restampRequirements }, fence, { stepBackReconsider: hasStepBackReconsiderMarker(plan.body) })}`,
  );
}

/**
 * Carry "these plan phases already landed" across the move, as a claim.
 *
 * Every durable record of a landed phase is keyed to the *forge* ref: the
 * merged PRs live on `claws/issue-<N>-` branches and their bodies say `Part of
 * #<N>`. The import changes the ref, so a multi-phase issue imported between
 * steps comes back as "phase 1 next" and Claws re-implements work that already
 * merged. `claws-phase-done:` is the one record that is not ref-keyed, so the
 * coverage is recomputed against the forge issue and written onto the native
 * one as a claim.
 *
 * Only `done` — a merged PR or an existing claim — is carried. A phase covered
 * only by a still-*open* PR has not landed, and claiming it would tell the
 * implementer to build the next phase on a base that lacks it; that PR is
 * logged instead, so the operator can re-point it by hand.
 *
 * `parsePhaseClaims` ignores a Claws-authored comment however trusted its
 * login, and ignores an untrusted login outright — hence a native comment
 * authored as `ALLOWED_ACTORS[0]` rather than anything carrying Claws' footer.
 */
async function carryPhaseCoverage(
  repo: string,
  issue: gh.Issue,
  nativeId: string,
  comments: { body: string; login: string }[],
): Promise<string | null> {
  const planText = planParser.findPlanComment(comments);
  if (!planText) return null;
  const peek = await peekTotalPhases(repo, issue.number, planText);
  if (peek.totalPhases <= 1) return null;

  const { totalPhases, coverage } = await loadIssuePhaseState(repo, issue.number, comments, { planText, stored: peek.stored });
  if (coverage.openPhases.length > 0) {
    log.warn(`[${NAME}] ${repo}#${issue.number}: phase(s) ${coverage.openPhases.join(", ")} are covered only by an open PR — that coverage does not survive the import`);
  }
  if (coverage.done.size === 0) return null;

  const actor = ALLOWED_ACTORS[0];
  if (!actor) {
    log.warn(`[${NAME}] ${repo}#${issue.number}: allowedActors is empty, so no trusted login can post the phase claim — coverage will not carry`);
    return null;
  }
  const done = [...coverage.done].sort((a, b) => a - b);
  log.info(`[${NAME}] ${repo}#${issue.number}: carrying phase(s) ${done.join(", ")} of ${totalPhases} across as a claim`);
  return await clawsIssues.commentOnIssue(repo, nativeId, `claws-phase-done: ${done.join(", ")}`, actor, { emitEvent: false });
}

/** Import every importable issue of `repo`. A failed issue is logged; the rest still import. */
export async function importRepo(repo: string, issues: readonly gh.Issue[]): Promise<ImportResult> {
  const selfLogin = gh.normalizeBotLogin(await gh.getSelfLoginForRepo(repo));
  let imported = 0;
  let failed = 0;
  let skipped = 0;
  for (const issue of issues) {
    try {
      const id = await importIssue(repo, issue, selfLogin);
      if (id === null) {
        skipped++;
        continue;
      }
      imported++;
      log.info(`[${NAME}] Imported ${repo}#${issue.number} as ${id}`);
    } catch (err) {
      failed++;
      log.error(`[${NAME}] Failed to import ${repo}#${issue.number}: ${err}`);
      await reportError(`${NAME}:import-issue`, `${repo}#${issue.number}`, err, { repo });
    }
  }
  return { repo, imported, failed, skipped };
}

/**
 * One listing-and-import pass over `repo`: list its importable issues, close
 * the CI duplicates among them, import the rest. Null when the listing or the
 * import threw (already reported) or there was nothing to import.
 */
function importPass(repo: Repo): Promise<{ result: ImportResult; truncated: boolean } | null> {
  const prev = repoLocks.get(repo.fullName) ?? Promise.resolve();
  const next = prev.then(() => importPassLocked(repo));
  const tail = next.catch(() => undefined);
  repoLocks.set(repo.fullName, tail);
  void tail.then(() => {
    if (repoLocks.get(repo.fullName) === tail) repoLocks.delete(repo.fullName);
  });
  return next;
}

/**
 * Per-repo import lock. The timer walk and the dispatcher's `importNewIssues`
 * both import, and two imports of one issue would delete each other's
 * attachment copies; Claws runs one pod, so an in-process chain suffices.
 */
const repoLocks = new Map<string, Promise<unknown>>();

/** The last holds-only summary logged per repo, so an unchanged set logs once. */
const loggedHoldsOnly = new Map<string, string>();

async function importPassLocked(repo: Repo): Promise<{ result: ImportResult; truncated: boolean } | null> {
  let importable: ImportableIssues;
  try {
    importable = await importableIssues(repo);
  } catch (err) {
    log.error(`[${NAME}] Could not list issues for ${repo.fullName}: ${err}`);
    await reportError(`${NAME}:list-issues`, repo.fullName, err, { repo: repo.fullName });
    return null;
  }
  let closedDuplicates = 0;
  for (const dup of importable.duplicates) {
    if (await closeCiDuplicate(repo, dup)) closedDuplicates++;
  }
  if (closedDuplicates > 0) {
    log.info(`[${NAME}] ${repo.fullName}: closed ${closedDuplicates} duplicate CI issue(s) as duplicates of main-build-monitor`);
  }
  if (importable.issues.length === 0) {
    const holds = holdsFor(repo.fullName).join(", ");
    if (holds !== (loggedHoldsOnly.get(repo.fullName) ?? "")) {
      loggedHoldsOnly.set(repo.fullName, holds);
      if (holds) log.info(`[${NAME}] ${repo.fullName}: nothing imported (${holds})`);
    }
    return null;
  }
  loggedHoldsOnly.delete(repo.fullName);

  log.info(`[${NAME}] Importing ${importable.issues.length} issue(s) from ${repo.fullName}`);
  try {
    return { result: await importRepo(repo.fullName, importable.issues), truncated: importable.truncated };
  } catch (err) {
    log.error(`[${NAME}] Could not import ${repo.fullName}: ${err}`);
    await reportError(`${NAME}:import-repo`, repo.fullName, err, { repo: repo.fullName });
    return null;
  }
}

/** The per-repo summary line, naming every issue left on the forge and why. */
function logRepoSummary(total: ImportResult, truncated: boolean): void {
  const next = truncated || total.skipped > 0
    ? " — the remaining issues will be picked up on a later run"
    : "";
  const holds = holdsFor(total.repo);
  const held = holds.length > 0 ? ` (${holds.join(", ")})` : "";
  log.info(`[${NAME}] ${total.repo}: imported ${total.imported}, failed ${total.failed}, skipped ${total.skipped}${held}${next}`);
}

/**
 * Import `repo`'s newly filed forge issues now, rather than on the timer.
 * `issue-dispatcher` calls this at the start of each repo's tick so a forge
 * issue is native before any agent acts on it (#clw_01M52GPG0E9DP8RQKW6ABH0X7R).
 * One pass; anything a truncated listing left over is picked up next tick.
 * Null when there was nothing to import.
 */
export async function importNewIssues(repo: Repo): Promise<ImportResult | null> {
  const pass = await importPass(repo);
  if (!pass) return null;
  logRepoSummary(pass.result, pass.truncated);
  return pass.result;
}

/**
 * Import every repository's importable issues.
 *
 * Walks `repos` in `listRepos` order, and within a repository keeps listing
 * while the forge listing truncated and the previous pass imported something:
 * `gh.closeIssue` invalidates the open-issues cache, so such a pass re-lists
 * fresh, whereas a pass that imported nothing would only see the same page
 * again. A repository whose listing or import throws is reported and the walk
 * moves on to the next one. Anything left behind — mid-flight, or past the
 * pass cap — is picked up by a later run.
 */
export async function run(repos: Repo[]): Promise<void> {
  let repoCount = 0;
  let imported = 0;
  let failed = 0;
  let skipped = 0;
  for (const repo of repos) {
    const total: ImportResult = { repo: repo.fullName, imported: 0, failed: 0, skipped: 0 };
    let truncated = false;
    let attempted = false;
    for (let pass = 0; pass < MAX_LISTING_PASSES; pass++) {
      const done = await importPass(repo);
      if (!done) break;
      attempted = true;
      truncated = done.truncated;
      const { result } = done;
      total.imported += result.imported;
      total.failed += result.failed;
      total.skipped += result.skipped;
      if (!done.truncated || result.imported === 0) break;
    }
    if (!attempted) continue;

    repoCount++;
    imported += total.imported;
    failed += total.failed;
    skipped += total.skipped;
    logRepoSummary(total, truncated);
  }
  if (repoCount === 0) {
    log.info(`[${NAME}] No repository has open forge issues left to import`);
    return;
  }
  log.info(`[${NAME}] ${repoCount} repo(s): imported ${imported}, failed ${failed}, skipped ${skipped}`);
}
