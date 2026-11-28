/**
 * Contract-agnostic drift infrastructure: checks that compare a repo's
 * declared policy (observability and security) with its code, and
 * the one per-repo follow-up issue that carries the policy's unaccepted
 * Known gaps together with any drift those checks find. A contract supplies
 * its own `DriftRule`s and the issue's dedupe key; this module owns running
 * them, dropping findings a Known gaps item or a scanner exception
 * (`.claws/contract-exceptions.yaml`) covers, and the issue lifecycle.
 * Suppression is scoped to one finding: its rule and key, or its fingerprint
 * (`findingFingerprint`), never a whole file. Known gaps lists real
 * shortfalls; a finding that is wrong or does not apply is an exception.
 * A contract also registers a `ContractAuditSpec` in `CONTRACT_AUDITS` for
 * the weekly `contract-audit` agent job.
 */
import crypto from "node:crypto";
import * as claude from "./claude.js";
import * as clawsIssues from "./claws-issues.js";
import { CONTRACT_EXCEPTIONS_PATH, type ContractException } from "./contract-exceptions.js";
import * as db from "./db.js";
import { retitleKeepingPlanCurrent } from "./issue-retitle.js";
import * as log from "./log.js";
import type { KnownGap } from "./observability-contract.js";
import { OBSERVABILITY_AUDIT } from "./observability-audit.js";
import { SECURITY_AUDIT } from "./security-audit.js";

/** One place a policy's claim and the code disagree. */
export interface DriftFinding {
  /** Id of the rule that found it. */
  rule: string;
  /** What a Known gaps item must mention to suppress it: a file path, dashboard path, uid or label value. */
  key: string;
  /** Repo-relative file the finding points at, when there is one. */
  file?: string;
  /** 1-based line in `file`. */
  line?: number;
  /** "The policy says X, the code shows Y", in one sentence. */
  message: string;
}

/** Returned by a rule that could not read what it needs; it concludes nothing. */
export interface DriftUnavailable {
  unavailable: string;
}

export interface DriftRule<C> {
  id: string;
  check(ctx: C): DriftFinding[] | DriftUnavailable;
}

export interface DriftRunResult {
  findings: DriftFinding[];
  unavailable: { rule: string; reason: string }[];
}

/** Runs every rule against `ctx`, collecting findings and the rules that could not run. */
export function runDriftRules<C>(rules: readonly DriftRule<C>[], ctx: C): DriftRunResult {
  const findings: DriftFinding[] = [];
  const unavailable: { rule: string; reason: string }[] = [];
  for (const rule of rules) {
    const result = rule.check(ctx);
    if (Array.isArray(result)) findings.push(...result);
    else unavailable.push({ rule: rule.id, reason: result.unavailable });
  }
  return { findings, unavailable };
}

/**
 * A finding's stable id: the first 8 hex chars of sha256 over its rule, key
 * and message. Computed on the fly, never stored; it changes when the message
 * does.
 */
export function findingFingerprint(f: Pick<DriftFinding, "rule" | "key" | "message">): string {
  return crypto.createHash("sha256").update(`${f.rule}\n${f.key}\n${f.message}`).digest("hex").slice(0, 8);
}

export interface SuppressOptions {
  /** The policy's Known gaps items, accepted or not. */
  gaps: readonly KnownGap[];
  /** The repo's valid scanner exceptions for this contract. */
  exceptions: readonly ContractException[];
  /** Audit findings: only fingerprint matches count (an exception's `finding`, a gap's backticked fingerprint). */
  audit?: boolean;
}

export interface SuppressResult<F extends DriftFinding> {
  kept: F[];
  /** Dropped by a Known gaps item naming the key and the rule id or fingerprint. */
  byGap: number;
  /** Dropped by a scanner exception. */
  byException: number;
}

function exceptionCovers(e: ContractException, f: DriftFinding, fingerprint: string, audit: boolean): boolean {
  if (e.rule !== f.rule || !e.keys.includes(f.key)) return false;
  if (e.finding !== undefined) return e.finding === fingerprint;
  return !audit;
}

function gapCovers(g: KnownGap, f: DriftFinding, fingerprint: string, audit: boolean): boolean {
  if (!g.text.includes(`\`${f.key}\``)) return false;
  if (g.text.includes(`\`${fingerprint}\``)) return true;
  return !audit && g.text.includes(`\`${f.rule}\``);
}

/**
 * Splits `findings` into those still reported and counts of those dropped, in
 * order: by a scanner exception (same rule, key in its `keys`, and fingerprint
 * equal when it pins one); then by a Known gaps item, accepted or not, naming
 * in backticks the finding's key and either its rule id or its fingerprint. A
 * gap naming only the key suppresses nothing. With `audit`, only fingerprint
 * matches count for exceptions and gaps.
 */
export function suppressFindings<F extends DriftFinding>(findings: readonly F[], opts: SuppressOptions): SuppressResult<F> {
  const audit = opts.audit ?? false;
  const result: SuppressResult<F> = { kept: [], byGap: 0, byException: 0 };
  for (const f of findings) {
    const fingerprint = findingFingerprint(f);
    if (opts.exceptions.some((e) => exceptionCovers(e, f, fingerprint, audit))) result.byException++;
    else if (opts.gaps.some((g) => gapCovers(g, f, fingerprint, audit))) result.byGap++;
    else result.kept.push(f);
  }
  return result;
}

/** Rule id of the finding reported for each problem in the scanner exceptions file. */
export const CONTRACT_EXCEPTIONS_RULE = "contract-exceptions";

/** One finding per exceptions-file problem; these are appended after suppression, so nothing hides them. */
export function exceptionProblemFindings(problems: readonly string[]): (DriftFinding & { file: string })[] {
  return problems.map((problem) => ({
    rule: CONTRACT_EXCEPTIONS_RULE,
    key: CONTRACT_EXCEPTIONS_PATH,
    file: CONTRACT_EXCEPTIONS_PATH,
    message: `An invalid scanner exceptions file or entry suppresses nothing: ${problem}.`,
  }));
}

/** `file:line`, `file`, or null when the finding names no file. */
function findingLocation(f: DriftFinding): string | null {
  if (!f.file) return null;
  return f.line !== undefined ? `${f.file}:${f.line}` : f.file;
}

function findingItem(f: DriftFinding): string {
  const at = findingLocation(f);
  const id = ` (rule \`${f.rule}\`, finding \`${findingFingerprint(f)}\`)`;
  return at ? `- \`${at}\`: ${f.message}${id}` : `- ${f.message}${id}`;
}

/**
 * Days a dated contract rule waits before, on its own, opening a new
 * follow-up issue; a burst of rule changes inside the window lands as one
 * round of issues. An open follow-up lists a new rule straight away.
 */
export const RULE_SETTLE_DAYS = 7;

/** A contract rule added or tightened after rollout, which a repo's existing policy fails. */
export interface BackfillRule {
  id: string;
  label: string;
  /** `YYYY-MM-DD` the rule was added or last tightened. */
  added: string;
}

/**
 * True when `missing` is non-empty and every rule in it carries an `added`
 * date: a repo whose existing policy fails only such rules gets them in its
 * follow-up issue instead of a fresh declare issue.
 */
export function isBackfillOnly(missing: readonly { added?: string }[]): boolean {
  return missing.length > 0 && missing.every((r) => typeof r.added === "string" && r.added !== "");
}

/** The dated rules in `rules`, narrowed to `BackfillRule`s. */
export function toBackfillRules(rules: readonly { id: string; label: string; added?: string }[]): BackfillRule[] {
  return rules.flatMap((r) => (r.added ? [{ id: r.id, label: r.label, added: r.added }] : []));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The furthest ahead, in days, a dated deferral may reach; a later date is unaccepted. */
export const MAX_DEFERRAL_DAYS = 366;

export type ResolvedGapState = "accepted" | "deferred" | "unaccepted";

/** A Known gaps item with the state it has on this scan. */
export interface ResolvedGap extends KnownGap {
  state: ResolvedGapState;
  /** A deferral that held until its date passed or its tracking issue closed; listed with `(deferral lapsed)`. */
  lapsed: boolean;
}

/**
 * Each gap's state on this scan. An `Accepted:` item is accepted. A dated
 * deferral holds through its UTC date inclusive and is unaccepted (lapsed)
 * from the next day; a date more than `MAX_DEFERRAL_DAYS` ahead is
 * unaccepted. An issue deferral holds while that Claws-native issue exists
 * and is open, and is unaccepted (lapsed) once it closes for any reason;
 * an unknown issue is unaccepted. A failed issue lookup counts as deferred
 * for this run and logs `warn`. Any other item is unaccepted.
 */
export async function resolveGapStates(
  gaps: readonly KnownGap[],
  now: Date = new Date(),
  logContext: { component?: string; repo?: string } = {},
): Promise<ResolvedGap[]> {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const out: ResolvedGap[] = [];
  for (const gap of gaps) {
    if (gap.accepted) {
      out.push({ ...gap, state: "accepted", lapsed: false });
      continue;
    }
    const until = gap.deferral?.until;
    if (until) {
      const days = (Date.parse(`${until}T00:00:00Z`) - today) / DAY_MS;
      if (days < 0) out.push({ ...gap, state: "unaccepted", lapsed: true });
      else if (days > MAX_DEFERRAL_DAYS) out.push({ ...gap, state: "unaccepted", lapsed: false });
      else out.push({ ...gap, state: "deferred", lapsed: false });
      continue;
    }
    const issue = gap.deferral?.issue;
    if (issue) {
      try {
        const record = await clawsIssues.getIssue(issue);
        if (!record) out.push({ ...gap, state: "unaccepted", lapsed: false });
        else if (record.state === "open") out.push({ ...gap, state: "deferred", lapsed: false });
        else out.push({ ...gap, state: "unaccepted", lapsed: true });
      } catch (err) {
        log.warn("deferral issue lookup failed", {
          component: logContext.component ?? "contract-drift",
          ...(logContext.repo ? { repo: logContext.repo } : {}),
          issue,
          error: err instanceof Error ? err.message : String(err),
        });
        out.push({ ...gap, state: "deferred", lapsed: false });
      }
      continue;
    }
    out.push({ ...gap, state: "unaccepted", lapsed: false });
  }
  return out;
}

/**
 * True when every rule was added at least `RULE_SETTLE_DAYS` UTC calendar
 * days before `now`. An unparseable date counts as settled, so a typo never
 * holds a follow-up forever.
 */
export function backfillSettled(rules: readonly BackfillRule[], now: Date): boolean {
  const today = Math.floor(now.getTime() / DAY_MS);
  return rules.every((r) => {
    const added = Date.parse(`${r.added}T00:00:00Z`);
    if (Number.isNaN(added)) return true;
    return today - Math.floor(added / DAY_MS) >= RULE_SETTLE_DAYS;
  });
}

export interface AuditFindings {
  findings: readonly DriftFinding[];
  /** When the audit ran, ISO 8601. */
  auditedAt: string;
  /** HEAD commit the audit read. */
  sha: string;
}

export interface FollowUpIssueOptions {
  /** Job that owns the issue, named in its body. */
  job: string;
  /** Repo full name; the issue's only repo. */
  repo: string;
  dedupeKey: string;
  /** Contract name used in the body, e.g. `observability`. */
  contract: string;
  /** Repo-relative path of the policy doc. */
  policyPath: string;
  /** Known gaps the policy lists that are neither accepted nor deferred; `lapsed` marks a deferral that ran out. */
  gaps: readonly (KnownGap & { lapsed?: boolean })[];
  /** Deterministic drift findings, already passed through `suppressFindings`. */
  drift: readonly DriftFinding[];
  /** Stored agent-audit findings, already passed through `suppressFindings` with `audit`; null when none. */
  audit: AuditFindings | null;
  /**
   * The repo clone's `origin/<default>` commit; null when unknown. When it differs from `audit.sha`
   * and the keyed issue closed as completed after the audit, the findings that issue listed are dropped.
   */
  headSha?: string | null;
  contractDocUrl: string;
  /**
   * Dated contract rules the existing policy fails and no undated rule, so the
   * scanner filed no declare issue for them; listed in their own section.
   */
  newRules?: readonly BackfillRule[];
  /** Clock for the `RULE_SETTLE_DAYS` window; defaults to now. */
  now?: Date;
}

export type FollowUpOutcome =
  | "none"
  | "unchanged"
  | "updated"
  | "filed"
  | "held-new-rules"
  | "skipped-not-planned"
  | "skipped-audit-superseded";

/**
 * True when a keyed issue closed as completed at or after the audit ran, so
 * the close resolved that audit's findings. `closed_at` is SQLite's zone-less
 * UTC `YYYY-MM-DD HH:MM:SS`; an unparseable or missing value is not superseding.
 */
export function auditSupersededByClose(
  closed: { state_reason: string | null; closed_at: string | null },
  audit: AuditFindings,
): boolean {
  if (closed.state_reason !== "completed" || !closed.closed_at) return false;
  let raw = closed.closed_at.trim();
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(raw)) raw = `${raw.replace(" ", "T")}Z`;
  const closedAt = Date.parse(raw);
  const auditedAt = Date.parse(audit.auditedAt);
  if (Number.isNaN(closedAt) || Number.isNaN(auditedAt)) return false;
  return closedAt >= auditedAt;
}

export function formatFollowUpBody(opts: FollowUpIssueOptions): string {
  const { contract, policyPath, gaps, drift } = opts;
  const newRules = opts.newRules ?? [];
  const auditFindings = opts.audit?.findings ?? [];
  const lines: string[] = [];
  if (gaps.length > 0) {
    lines.push(
      `\`${policyPath}\` lists ${gaps.length} known ${contract} gap(s) under \`### Known gaps\` that are neither accepted nor deferred: places where this repo's existing code falls short of the St-John-Software ${contract} contract or of the policy's own per-change rules.`,
    );
  } else if (drift.length === 0 && auditFindings.length === 0 && newRules.length > 0) {
    lines.push(
      `\`${policyPath}\` declares this repo's ${contract} policy, but it does not yet meet ${newRules.length} St-John-Software ${contract} contract rule(s) added since it was declared.`,
    );
  } else {
    lines.push(
      `\`${policyPath}\` declares this repo's ${contract} policy, and the checks below found places where what it says and what the code shows disagree.`,
    );
  }
  if (gaps.length > 0) {
    lines.push("", "**Unaccepted gaps:**", "", ...gaps.map((g) => `- ${g.text}${g.lapsed ? " (deferral lapsed)" : ""}`));
  }
  if (drift.length > 0) {
    lines.push("", "**Drift: the policy says X, the code shows Y:**", "", ...drift.map(findingItem));
  }
  if (opts.audit && auditFindings.length > 0) {
    lines.push(
      "",
      `**Audit findings** (agent audit of ${opts.audit.auditedAt.slice(0, 10)} at \`${opts.audit.sha.slice(0, 12)}\`):`,
      "",
      ...auditFindings.map(findingItem),
    );
  }
  if (newRules.length > 0) {
    lines.push(
      "",
      "**Contract rules added since this policy was declared:**",
      "",
      ...newRules.map((r) => `- ${r.label} (\`${r.id}\`, added ${r.added})`),
    );
  }
  lines.push("", "**Asks:**", "");
  if (gaps.length > 0) {
    lines.push("- [ ] Close each gap by fixing the code (for observability, instrumenting it), then remove it from the policy's Known gaps list (or write `None.` once the list is empty).");
  }
  if (drift.length > 0 || auditFindings.length > 0) {
    lines.push(
      "- [ ] For each drift or audit finding, pick one:",
      "  - Fix the code, or correct the policy so it matches the code.",
      "  - For a real shortfall the repo keeps, list it under `### Known gaps` in an item that names, in backticks, the finding's key (its file, path, uid or label value) and its rule id; for an audit finding, its finding id instead of the rule.",
      `  - For a finding that is wrong or does not apply, add an entry to \`${CONTRACT_EXCEPTIONS_PATH}\` with \`contract\`, \`rule\`, \`keys\` (the finding's exact keys) and \`reason\`, plus \`finding\` (the finding id, as a quoted string such as \`finding: "1a2b3c4d"\`) for an audit finding; never an \`Accepted:\` gap.`,
    );
  }
  if (newRules.length > 0) {
    lines.push(
      `- [ ] Add each contract rule above to \`${policyPath}\` as an edit, not a rewrite, and check what you write against the code; list any shortfall under \`### Known gaps\`.`,
    );
  }
  lines.push(
    "- [ ] For a gap the repo does not fix now, pick one:",
    "  - Start its item `Accepted: <reason>` to live with it.",
    "  - Start its item `Deferred until YYYY-MM-DD: <reason>` (at most a year ahead) or `Deferred (#clw_…): <reason>` when it cannot be fixed yet; the scan lists it here again once the date passes or that issue closes.",
    "",
    `The daily \`${opts.job}\` scan rewrites this body while the issue is open. Close it as completed once no unaccepted gap or finding remains${newRules.length > 0 ? " and the policy meets every contract rule" : ""}. A close as not planned dismisses only the gaps and findings listed here: a gap or finding that appears later (a reworded gap, or a finding whose message changes, counts as new) files a new issue${newRules.length > 0 ? ", and contract rules the policy still misses re-file once they have settled" : ""}. Listing \`${opts.job}\` in the repo's \`claws.json\` \`disabledJobs\` opts the repo out for good.`,
    "",
    `Canonical contract: ${opts.contractDocUrl}`,
  );
  return lines.join("\n");
}

/** The longest follow-up issue title `followUpTitle` builds. */
export const FOLLOW_UP_TITLE_MAX = 100;

/** Trailing whitespace and punctuation a title phrase drops. */
const TRAILING_PUNCT = /[\s.,;:!?\u2014-]+$/;

function tidyPhrase(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(TRAILING_PUNCT, "");
}

/** `text` up to the first of `seps`, or whole. */
function cutAtFirst(text: string, seps: readonly string[]): string {
  let end = text.length;
  for (const sep of seps) {
    const i = text.indexOf(sep);
    if (i > 0 && i < end) end = i;
  }
  return text.slice(0, end);
}

/** A Known gaps item as a title phrase: its first clause, without markdown marks or an `Unaccepted:` label. */
function gapPhrase(gap: KnownGap): string {
  let text = gap.text.replace(/\s+/g, " ").trim();
  text = text.replace(/^[*_`\s]+/, "").replace(/^Unaccepted\s*[*_`]*\s*:\s*[*_`]*\s*/i, "");
  text = text.replace(/^Deferred\s*(?:until\s+\d{4}-\d{2}-\d{2}|\(#?clw_[0-9A-Za-z]+\))[*_`]*\s*:\s*[*_`]*\s*/i, "");
  text = text.replace(/[`*]/g, "");
  return tidyPhrase(cutAtFirst(text, ["; ", ". ", " \u2014 ", ", so ", " ("]));
}

/** A drift or audit finding as a title phrase: what the code shows, prefixed with the file's basename. */
function findingPhrase(f: DriftFinding): string {
  let text = f.message.replace(/\s+/g, " ").trim();
  let from = -1;
  for (const sep of ["; the code shows ", ", but "]) {
    const i = text.lastIndexOf(sep);
    if (i >= 0 && i + sep.length > from) from = i + sep.length;
  }
  if (from >= 0) text = text.slice(from);
  text = text.replace(/^`[^`]+`:\s*/, "").replace(/`/g, "");
  text = tidyPhrase(cutAtFirst(text, [". ", "; "]));
  if (!f.file) return text;
  const base = f.file.split("/").pop() || f.file;
  return `${base}: ${text}`;
}

/** `text` clipped at a word boundary to at most `max` characters, ending `…` when clipped. */
function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - 1);
  let cut = text.slice(0, room);
  const space = cut.lastIndexOf(" ");
  if (space > 0) cut = cut.slice(0, space);
  return `${cut.replace(TRAILING_PUNCT, "")}\u2026`;
}

/**
 * The follow-up issue's title, built from the items `formatFollowUpBody`
 * lists, in body order (gaps, drift, audit findings, new rules), at most
 * `FOLLOW_UP_TITLE_MAX` characters. One item: `<contract>: <phrase>`.
 * Several: `<contract>: <N> gaps — <phrase>, <phrase>, …` (`findings` when
 * none is a Known gap, `items` when mixed); phrases are added while they fit,
 * the first is clipped at a word boundary when it alone does not, and `, …`
 * marks any left out. Deterministic: the same items give the same title.
 */
export function followUpTitle(opts: FollowUpIssueOptions): string {
  const phrases = [
    ...opts.gaps.map(gapPhrase),
    ...opts.drift.map(findingPhrase),
    ...(opts.audit?.findings ?? []).map(findingPhrase),
    ...(opts.newRules ?? []).map((r) => `policy lacks the ${r.id} rule`),
  ].map((p) => p || "unnamed item");
  const head = `${opts.contract}: `;
  if (phrases.length <= 1) return clipWords(`${head}${phrases[0] ?? "no outstanding items"}`, FOLLOW_UP_TITLE_MAX);
  const gapCount = opts.gaps.length;
  const noun = gapCount === phrases.length ? "gaps" : gapCount === 0 ? "findings" : "items";
  const prefix = `${head}${phrases.length} ${noun} \u2014 `;
  const all = `${prefix}${phrases.join(", ")}`;
  if (all.length <= FOLLOW_UP_TITLE_MAX) return all;
  const more = ", \u2026";
  let kept = "";
  for (const p of phrases) {
    const next = kept ? `${kept}, ${p}` : p;
    if (prefix.length + next.length + more.length > FOLLOW_UP_TITLE_MAX) break;
    kept = next;
  }
  if (!kept) kept = clipWords(phrases[0]!, FOLLOW_UP_TITLE_MAX - prefix.length - more.length);
  return `${prefix}${kept}${more}`;
}

/** Whitespace-collapsed gap text, as compared for not-planned dismissal. */
export function normaliseGapText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const LAPSED_SUFFIX = /\s*\(deferral lapsed\)$/;
const FINDING_ID = /finding `([0-9a-f]{8})`/g;

/** What closed-as-not-planned follow-up issues listed, and so dismissed. */
export interface DismissedItems {
  /** Gap texts from each body's `**Unaccepted gaps:**` list, normalised. */
  gaps: Set<string>;
  /** Drift and audit finding ids (`findingFingerprint`). */
  findings: Set<string>;
}

/**
 * The union of the items listed by follow-up issue `bodies`: every gap under
 * `**Unaccepted gaps:**` (leading `- ` and a trailing `(deferral lapsed)`
 * removed, whitespace collapsed) and every id written as ``finding `<8 hex>` ``.
 */
export function dismissedItems(bodies: readonly string[]): DismissedItems {
  const gaps = new Set<string>();
  const findings = new Set<string>();
  for (const body of bodies) {
    const lines = body.split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === "**Unaccepted gaps:**");
    if (start >= 0) {
      let i = start + 1;
      while (i < lines.length && lines[i]!.trim() === "") i++;
      for (; i < lines.length && lines[i]!.startsWith("- "); i++) {
        const text = normaliseGapText(lines[i]!.slice(2).replace(LAPSED_SUFFIX, ""));
        if (text) gaps.add(text);
      }
    }
    for (const m of body.matchAll(FINDING_ID)) findings.add(m[1]!);
  }
  return { gaps, findings };
}

/**
 * Drops from `opts` the gaps, drift and audit findings that a keyed issue
 * closed as not planned listed; `newRules` are never dismissed. Returns the
 * remainder and how many items were dropped.
 */
async function dropDismissedItems(opts: FollowUpIssueOptions): Promise<{ opts: FollowUpIssueOptions; dismissed: number }> {
  const closed = await clawsIssues.listNotPlannedIssuesByDedupeKey(opts.repo, opts.dedupeKey);
  if (closed.length === 0) return { opts, dismissed: 0 };
  const dismissed = dismissedItems(closed.map((c) => c.body ?? ""));
  const gaps = opts.gaps.filter((g) => !dismissed.gaps.has(normaliseGapText(g.text)));
  const drift = opts.drift.filter((f) => !dismissed.findings.has(findingFingerprint(f)));
  const auditKept = opts.audit?.findings.filter((f) => !dismissed.findings.has(findingFingerprint(f))) ?? [];
  const audit = opts.audit && auditKept.length > 0 ? { ...opts.audit, findings: auditKept } : null;
  const count =
    opts.gaps.length - gaps.length + opts.drift.length - drift.length + (opts.audit?.findings.length ?? 0) - auditKept.length;
  return { opts: count === 0 ? opts : { ...opts, gaps, drift, audit }, dismissed: count };
}

/**
 * Removes the stored audit findings that the keyed issue, closed as completed after the audit ran,
 * listed by location, once the repo's default branch has moved past the audited commit: they were
 * fixed between audits. Leaves `opts` untouched when the head is unknown or unchanged.
 */
async function dropResolvedAuditFindings(opts: FollowUpIssueOptions): Promise<FollowUpIssueOptions> {
  const { audit, headSha } = opts;
  if (!audit || audit.findings.length === 0 || !headSha || headSha === audit.sha) return opts;
  const closed = await clawsIssues.findRecentlyClosedIssueByDedupeKey(opts.repo, opts.dedupeKey, new Date(audit.auditedAt));
  if (!closed || closed.state_reason !== "completed") return opts;
  const body = closed.body ?? "";
  const kept = audit.findings.filter((f) => {
    const at = findingLocation(f);
    return !at || !body.includes(`\`${at}\``);
  });
  const dropped = audit.findings.length - kept.length;
  if (dropped === 0) return opts;
  log.info("audit findings resolved by completed close", {
    component: opts.job,
    repo: opts.repo,
    dedupe_key: opts.dedupeKey,
    issue: closed.id,
    audit_sha: audit.sha,
    head_sha: headSha,
    dropped,
  });
  return { ...opts, audit: kept.length > 0 ? { ...audit, findings: kept } : null };
}

/**
 * Files, or rewrites in place, the repo's one follow-up issue for its
 * policy's unaccepted Known gaps, its drift and audit findings, and the dated
 * contract rules it misses (`newRules`), keyed `opts.dedupeKey`. Files nothing
 * when all four lists are empty; re-files after a close as completed only
 * while items remain. A completed close also supersedes audit findings from an
 * audit at or before it, which are dropped on the re-file path.
 *
 * An open issue lists every new rule at once. With none open, new rules alone
 * open one only once every one is `RULE_SETTLE_DAYS` old (`held-new-rules`
 * until then). Gaps and drift and audit findings that any keyed issue closed
 * as not planned listed are dismissed and never listed again; new rules are
 * never dismissed. When dismissal leaves no gap or finding and no settled new
 * rule (`skipped-not-planned`), nothing is filed.
 *
 * The title is `followUpTitle` of the listed items and is rewritten with the
 * body. A title-only change (body unchanged, e.g. a new title format) goes
 * through `retitleKeepingPlanCurrent`, so it never re-plans the issue; an
 * unchanged title and body make no write.
 */
export async function refreshFollowUpIssue(input: FollowUpIssueOptions): Promise<FollowUpOutcome> {
  const resolved = await dropResolvedAuditFindings(input);
  const newRules = resolved.newRules ?? [];
  const now = resolved.now ?? new Date();
  if (resolved.gaps.length + resolved.drift.length + (resolved.audit?.findings.length ?? 0) + newRules.length === 0) return "none";
  const { opts, dismissed } = await dropDismissedItems(resolved);
  const auditCount = opts.audit?.findings.length ?? 0;
  const fields = {
    component: opts.job,
    repo: opts.repo,
    dedupe_key: opts.dedupeKey,
    gaps: opts.gaps.length,
    drift: opts.drift.length,
    audit: auditCount,
    new_rules: newRules.length,
    ...(dismissed > 0 ? { dismissed } : {}),
  };
  const remaining = opts.gaps.length + opts.drift.length + auditCount;

  const open = await clawsIssues.findOpenIssueByDedupeKey(opts.repo, opts.dedupeKey);
  if (open && remaining + newRules.length > 0) {
    const body = formatFollowUpBody(opts);
    const title = followUpTitle(opts);
    if (open.body === body) {
      if (open.title === title) return "unchanged";
      if (!(await retitleKeepingPlanCurrent(opts.repo, open.id, open.title, body, title))) return "unchanged";
      log.info("follow-up issue retitled", { ...fields, issue: open.id });
      return "updated";
    }
    await clawsIssues.editIssue(open.id, body);
    const retitled = open.title !== title;
    if (retitled) await clawsIssues.editIssueTitle(open.id, title);
    log.info("follow-up issue updated", { ...fields, issue: open.id, ...(retitled ? { retitled: true } : {}) });
    return "updated";
  }
  if (dismissed > 0 && remaining === 0 && (newRules.length === 0 || !backfillSettled(newRules, now))) {
    log.info("follow-up issue skipped", { ...fields, reason: "closed_not_planned" });
    return "skipped-not-planned";
  }
  const closed = await clawsIssues.findRecentlyClosedIssueByDedupeKey(opts.repo, opts.dedupeKey, new Date(0));
  let effective = opts;
  if (opts.audit && closed && auditSupersededByClose(closed, opts.audit)) {
    effective = { ...opts, audit: null };
    if (opts.gaps.length + opts.drift.length + newRules.length === 0) {
      log.info("follow-up issue skipped", { ...fields, issue: closed.id, reason: "audit_superseded" });
      return "skipped-audit-superseded";
    }
  }
  const otherItems = effective.gaps.length + effective.drift.length + (effective.audit?.findings.length ?? 0);
  if (otherItems === 0 && !backfillSettled(newRules, now)) {
    log.info("follow-up issue held", {
      ...fields,
      ...(closed ? { issue: closed.id } : {}),
      reason: "new_rules_settling",
      rules: newRules.map((r) => r.id),
    });
    return "held-new-rules";
  }
  const id = await clawsIssues.createIssue({
    title: followUpTitle(effective),
    body: formatFollowUpBody(effective),
    authorLogin: clawsIssues.CLAWS_NATIVE_LOGIN,
    repos: [opts.repo],
    source: "automation",
    dedupeKey: opts.dedupeKey,
  });
  log.info("follow-up issue filed", { ...fields, issue: id });
  return "filed";
}

/**
 * Logs one `contract rule backfill` line per dated rule any repo fails, with
 * the repos failing it, so the operator sees a rule change's blast radius.
 * `failing` maps each repo's full name to the dated rules it fails.
 */
export function logBackfillSummary(
  job: string,
  contract: string,
  failing: ReadonlyMap<string, readonly BackfillRule[]>,
  now: Date = new Date(),
): void {
  const byRule = new Map<string, { rule: BackfillRule; repos: string[] }>();
  for (const [repo, rules] of failing) {
    for (const rule of rules) {
      const entry = byRule.get(rule.id) ?? { rule, repos: [] };
      entry.repos.push(repo);
      byRule.set(rule.id, entry);
    }
  }
  for (const { rule, repos } of byRule.values()) {
    const sorted = [...repos].sort();
    log.info("contract rule backfill", {
      component: job,
      contract,
      rule: rule.id,
      added: rule.added,
      settled: backfillSettled([rule], now),
      failing: sorted.length,
      repos: sorted,
    });
  }
}

/** A repo's declared policy for one contract: the doc it lives in and its text. */
export interface ContractPolicy {
  /** Repo-relative path of the policy doc. */
  path: string;
  text: string;
}

/**
 * How the weekly `contract-audit` agent job audits one contract: where the
 * policy lives, what the agent is asked, how its answer is parsed, and the
 * follow-up issue the contract's daily scanner carries the findings in.
 */
export interface ContractAuditSpec {
  /** Contract name, the `contract_audits.contract` key, e.g. `observability`. */
  contract: string;
  /** The contract's daily scanner job; a repo with it disabled is not audited. */
  scannerJob: string;
  /**
   * Weekdays after the repo's base first-audit weekday on which this contract's
   * first audit lands, so two contracts' first audits do not fall on one day. Default 0.
   */
  firstAuditOffsetDays?: number;
  /** The policy, or null when the repo declares none or opts out (e.g. the no-telemetry sentence). */
  readPolicy(repoDir: string): ContractPolicy | null;
  /**
   * The agent prompt. `sinceSha` is the last audited HEAD, or null on a first
   * audit (or when it is no longer an ancestor of HEAD); `gitLog` is the
   * `git log --stat` of that range; `exceptions` are the worktree's scanner
   * exceptions for this contract.
   */
  buildPrompt(
    policy: ContractPolicy,
    sinceSha: string | null,
    knownGaps: readonly KnownGap[],
    gitLog: string,
    exceptions: readonly ContractException[],
  ): string;
  /** The repo's valid scanner exceptions for this contract; problems are reported by the daily scanner. */
  readExceptions(repoDir: string): ContractException[];
  /** The agent's findings, or null when its output holds no valid findings object. */
  parseFindings(output: string, onFailure?: (err: unknown, candidates: string[]) => void): DriftFinding[] | null;
  /** Identity of the follow-up issue the scanner refreshes with these findings. */
  followUp: { dedupeKey: string; contractDocUrl: string };
}

/** Every contract the `contract-audit` job audits. */
export const CONTRACT_AUDITS: readonly ContractAuditSpec[] = [OBSERVABILITY_AUDIT, SECURITY_AUDIT];

/** Stored findings (the `contract_audits.findings` JSON) narrowed back to `DriftFinding`s; malformed items are dropped. */
export function toDriftFindings(stored: readonly unknown[]): DriftFinding[] {
  const out: DriftFinding[] = [];
  for (const item of stored) {
    if (typeof item !== "object" || item === null) continue;
    const f = item as Record<string, unknown>;
    if (typeof f["rule"] !== "string" || typeof f["key"] !== "string" || typeof f["message"] !== "string") continue;
    out.push({
      rule: f["rule"],
      key: f["key"],
      message: f["message"],
      ...(typeof f["file"] === "string" ? { file: f["file"] } : {}),
      ...(typeof f["line"] === "number" ? { line: f["line"] } : {}),
    });
  }
  return out;
}

/**
 * The latest stored audit findings of `spec.contract` for `repo`, minus those a
 * scanner exception (`spec.readExceptions`) or Known gaps item covers (by
 * fingerprint) and those whose file changed (or was
 * deleted) between the audited SHA and `origin/<default>`; the next audit
 * re-checks such files. Findings with no `file` (those in another repo) are
 * never stale here. The follow-up refresh may further drop findings a
 * completed close of the follow-up issue already listed (see
 * `refreshFollowUpIssue`). Every finding is kept when the diff cannot run.
 * `audit` is null when the repo has never been audited or none remain.
 */
export async function storedAuditFindings(
  spec: Pick<ContractAuditSpec, "contract" | "readExceptions">,
  job: string,
  repo: { fullName: string; defaultBranch: string },
  repoDir: string,
  gaps: readonly KnownGap[],
): Promise<{ audit: AuditFindings | null; stale: number; suppressed: number; excepted: number }> {
  const none = { suppressed: 0, excepted: 0 };
  const stored = await db.getContractAudit(spec.contract, repo.fullName);
  if (!stored) return { audit: null, stale: 0, ...none };
  const s = suppressFindings(toDriftFindings(stored.findings), {
    gaps,
    exceptions: spec.readExceptions(repoDir),
    audit: true,
  });
  const counts = { suppressed: s.byGap, excepted: s.byException };
  let findings = s.kept;
  let stale = 0;
  const files = [...new Set(findings.map((f) => f.file).filter((f): f is string => !!f))];
  if (files.length > 0) {
    try {
      const out = await claude.git(
        ["diff", "--name-only", stored.headSha, `origin/${repo.defaultBranch}`, "--", ...files],
        repoDir,
        { maxRetries: 0 },
      );
      const changed = new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
      const kept = findings.filter((f) => !f.file || !changed.has(f.file));
      stale = findings.length - kept.length;
      findings = kept;
    } catch (err) {
      log.warn("audit staleness check failed", {
        component: job,
        repo: repo.fullName,
        sha: stored.headSha,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (findings.length === 0) return { audit: null, stale, ...counts };
  return { audit: { findings, auditedAt: stored.auditedAt, sha: stored.headSha }, stale, ...counts };
}
