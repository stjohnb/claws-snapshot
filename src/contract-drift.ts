/**
 * Contract-agnostic drift infrastructure: checks that compare a repo's
 * declared policy (observability today, security next) with its code, and
 * the one per-repo follow-up issue that carries the policy's unaccepted
 * Known gaps together with any drift those checks find. A contract supplies
 * its own `DriftRule`s and issue title/dedupe key; this module owns running
 * them, dropping findings the policy already lists, and the issue lifecycle.
 * A contract also registers a `ContractAuditSpec` in `CONTRACT_AUDITS` for
 * the weekly `contract-audit` agent job.
 */
import * as clawsIssues from "./claws-issues.js";
import * as log from "./log.js";
import type { KnownGap } from "./observability-contract.js";
import { OBSERVABILITY_AUDIT } from "./observability-audit.js";

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
 * Drops each finding whose `key` appears, in backticks, in the text of any Known gaps item,
 * accepted or not: a listed shortfall is already tracked.
 */
export function suppressListed(findings: readonly DriftFinding[], gaps: readonly KnownGap[]): DriftFinding[] {
  return findings.filter((f) => !gaps.some((g) => g.text.includes(`\`${f.key}\``)));
}

/** `file:line`, `file`, or null when the finding names no file. */
function findingLocation(f: DriftFinding): string | null {
  if (!f.file) return null;
  return f.line !== undefined ? `${f.file}:${f.line}` : f.file;
}

function findingItem(f: DriftFinding): string {
  const at = findingLocation(f);
  return at ? `- \`${at}\`: ${f.message}` : `- ${f.message}`;
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
  title: string;
  dedupeKey: string;
  /** Contract name used in the body, e.g. `observability`. */
  contract: string;
  /** Repo-relative path of the policy doc. */
  policyPath: string;
  /** Known gaps the policy lists that are not accepted. */
  gaps: readonly KnownGap[];
  /** Deterministic drift findings, already passed through `suppressListed`. */
  drift: readonly DriftFinding[];
  /** Stored agent-audit findings, already passed through `suppressListed`; null when none. */
  audit: AuditFindings | null;
  contractDocUrl: string;
}

export type FollowUpOutcome = "none" | "unchanged" | "updated" | "filed" | "skipped-not-planned";

export function formatFollowUpBody(opts: FollowUpIssueOptions): string {
  const { contract, policyPath, gaps, drift } = opts;
  const auditFindings = opts.audit?.findings ?? [];
  const lines: string[] = [];
  if (gaps.length > 0) {
    lines.push(
      `\`${policyPath}\` lists ${gaps.length} known ${contract} gap(s) under \`### Known gaps\` that are not marked accepted: places where this repo's existing code falls short of the St-John-Software ${contract} contract or of the policy's own per-change rules.`,
    );
  } else {
    lines.push(
      `\`${policyPath}\` declares this repo's ${contract} policy, and the checks below found places where what it says and what the code shows disagree.`,
    );
  }
  if (gaps.length > 0) {
    lines.push("", "**Unaccepted gaps:**", "", ...gaps.map((g) => `- ${g.text}`));
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
  lines.push("", "**Asks:**", "");
  if (gaps.length > 0) {
    lines.push("- [ ] Close each gap by fixing the code (for observability, instrumenting it), then remove it from the policy's Known gaps list (or write `None.` once the list is empty).");
  }
  if (drift.length > 0 || auditFindings.length > 0) {
    lines.push(
      "- [ ] For each drift or audit finding, fix the code, or correct the policy and list the shortfall under `### Known gaps` (a listed item that names, in backticks, the finding's file, path, uid or label value stops it being raised).",
    );
  }
  lines.push(
    "- [ ] A gap the repo decides to live with stays listed with its item starting `Accepted: <reason>` instead.",
    "",
    `The daily \`${opts.job}\` scan rewrites this body while the issue is open and never re-files it after a close as not planned. Close it as completed once no unaccepted gap or finding remains.`,
    "",
    `Canonical contract: ${opts.contractDocUrl}`,
  );
  return lines.join("\n");
}

/**
 * Files, or rewrites in place, the repo's one follow-up issue for its
 * policy's unaccepted Known gaps and its drift and audit findings, keyed
 * `opts.dedupeKey`. Files nothing when all three lists are empty; never
 * re-files after the newest keyed issue closed as not planned, and re-files
 * after a close as completed only while items remain.
 */
export async function refreshFollowUpIssue(opts: FollowUpIssueOptions): Promise<FollowUpOutcome> {
  const auditCount = opts.audit?.findings.length ?? 0;
  const items = opts.gaps.length + opts.drift.length + auditCount;
  if (items === 0) return "none";
  const fields = {
    component: opts.job,
    repo: opts.repo,
    dedupe_key: opts.dedupeKey,
    gaps: opts.gaps.length,
    drift: opts.drift.length,
    audit: auditCount,
  };

  const body = formatFollowUpBody(opts);
  const open = await clawsIssues.findOpenIssueByDedupeKey(opts.repo, opts.dedupeKey);
  if (open) {
    if (open.body === body) return "unchanged";
    await clawsIssues.editIssue(open.id, body);
    log.info("follow-up issue updated", { ...fields, issue: open.id });
    return "updated";
  }
  const closed = await clawsIssues.findRecentlyClosedIssueByDedupeKey(opts.repo, opts.dedupeKey, new Date(0));
  if (closed?.state_reason === "not_planned") {
    log.info("follow-up issue skipped", { ...fields, issue: closed.id, reason: "closed_not_planned" });
    return "skipped-not-planned";
  }
  const id = await clawsIssues.createIssue({
    title: opts.title,
    body,
    authorLogin: clawsIssues.CLAWS_NATIVE_LOGIN,
    repos: [opts.repo],
    source: "automation",
    dedupeKey: opts.dedupeKey,
  });
  log.info("follow-up issue filed", { ...fields, issue: id });
  return "filed";
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
  /** The policy, or null when the repo declares none or opts out (e.g. the no-telemetry sentence). */
  readPolicy(repoDir: string): ContractPolicy | null;
  /**
   * The agent prompt. `sinceSha` is the last audited HEAD, or null on a first
   * audit (or when it is no longer an ancestor of HEAD); `gitLog` is the
   * `git log --stat` of that range.
   */
  buildPrompt(policy: ContractPolicy, sinceSha: string | null, knownGaps: readonly KnownGap[], gitLog: string): string;
  /** The agent's findings, or null when its output holds no valid findings object. */
  parseFindings(output: string, onFailure?: (err: unknown, candidates: string[]) => void): DriftFinding[] | null;
  /** Identity of the follow-up issue the scanner refreshes with these findings. */
  followUp: { title: string; dedupeKey: string; contractDocUrl: string };
}

/** Every contract the `contract-audit` job audits. */
export const CONTRACT_AUDITS: readonly ContractAuditSpec[] = [OBSERVABILITY_AUDIT];

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
