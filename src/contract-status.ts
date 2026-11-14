/**
 * Where each managed repo stands against each contract, for the dashboard's
 * `/contracts` pages (docs/product/dashboard-and-integrations.md "Show where
 * every repo stands against its contracts"). The contracts' daily scanners
 * save one `ContractStatusSnapshot` per (contract, repo) in the
 * `contract_status` table; the pages read those rows and combine them with
 * the live job-disable config, stored audit times and open follow-up issues.
 * Everything here but `saveContractSnapshot` is pure.
 */
import type { DriftFinding } from "./contract-drift.js";
import * as db from "./db.js";
import * as log from "./log.js";

export type ContractName = "observability" | "security";

/** One contract-level requirement an accepted gap can waive, matched by keyword. */
export interface ContractRequirement {
  label: string;
  pattern: RegExp;
}

export interface ContractSpec {
  contract: ContractName;
  /** Display name. */
  label: string;
  /** The contract's daily scanner job. */
  scannerJob: string;
  /** Former names of the scanner a disable config may still list. */
  aliases: readonly string[];
  /** Dedupe key of the scanner's per-repo known-gaps follow-up issue. */
  dedupeKey: string;
  /** The job auditing this contract, or null when none audits it yet. */
  auditJob: string | null;
  requirements: readonly ContractRequirement[];
}

/** The job that runs every contract scanner; disabling it disables them all. */
export const SCANNER_DISPATCHER = "scanner-dispatcher";

// Literal rather than imported from the scanners, which import this module;
// contract-status.test.ts asserts they match the scanners' own constants.
/** Negation prefix shared by the requirement patterns: an absence word near the noun. */
const ABSENT = String.raw`(?:\bno\b|\bnot\b|\bwithout\b|\black(?:s|ing)?\b|\bmissing\b|\bdisabled?\b|\bnever\b)`;

export const CONTRACTS: readonly ContractSpec[] = [
  {
    contract: "observability",
    label: "Observability",
    scannerJob: "observability-contract-scanner",
    aliases: ["logging-conventions-scanner"],
    dedupeKey: "observability-known-gaps",
    auditJob: "contract-audit",
    requirements: [
      { label: "Metrics endpoint", pattern: new RegExp(String.raw`${ABSENT}[^.;,]{0,40}?(?:\/metrics\b|metrics endpoint|prometheus)`, "i") },
      { label: "Dashboard", pattern: new RegExp(String.raw`${ABSENT}[^.;,]{0,40}?(?:\bdashboards?\b)`, "i") },
      { label: "Alert rule", pattern: new RegExp(String.raw`${ABSENT}[^.;,]{0,40}?(?:\balert(?:s|ing)?\b)`, "i") },
      { label: "Traces", pattern: new RegExp(String.raw`${ABSENT}[^.;,]{0,40}?(?:\btrac(?:es|ing)\b|opentelemetry|\botel\b)`, "i") },
      { label: "Structured JSON logging", pattern: new RegExp(String.raw`${ABSENT}[^.;,]{0,40}?(?:\bjson\b|structured log)`, "i") },
      { label: "Latency budgets", pattern: new RegExp(String.raw`${ABSENT}[^.;,]{0,40}?(?:\blatency\b|\bbudgets?\b)`, "i") },
      { label: "Log shipping to Loki", pattern: new RegExp(String.raw`${ABSENT}[^.;,]{0,40}?(?:\bloki\b|log shipping)`, "i") },
    ],
  },
  {
    contract: "security",
    label: "Security",
    scannerJob: "security-contract-scanner",
    aliases: [],
    dedupeKey: "security-known-gaps",
    auditJob: "contract-audit",
    requirements: [
      { label: "Image scan gate", pattern: new RegExp(String.raw`\bunscanned\b|${ABSENT}[^.;,]{0,40}?(?:\b(?:image )?scan(?:s|ning)?\b|\btrivy\b|\bgrype\b)`, "i") },
      { label: "Action SHA pinning", pattern: new RegExp(String.raw`\bunpinned (?:actions?|workflows?)\b|\bactions?\b[^.;,]{0,40}\bnot pinned\b|${ABSENT}[^.;,]{0,40}?(?:\baction\b[^.;]{0,20}\bsha\b|\bsha[- ]pinn)`, "i") },
      { label: "VEX statements", pattern: new RegExp(String.raw`${ABSENT}[^.;,]{0,40}?(?:\.vex\b|\bopenvex\b|\bvex\b)`, "i") },
      { label: "Secrets handling", pattern: new RegExp(String.raw`${ABSENT}[^.;,]{0,40}?(?:\bsecrets? (?:scan|handling|manag)\w*|\bsecrets?\b)`, "i") },
      { label: "Network exposure", pattern: new RegExp(String.raw`${ABSENT}[^.;,]{0,40}?(?:\bnetwork ?polic|\bauthenticat\w*|\bingress\b)`, "i") },
      { label: "Dependency updates", pattern: new RegExp(String.raw`${ABSENT}[^.;,]{0,40}?(?:\brenovate\b|\bdependabot\b|dependency updates?)|\b(?:renovate|dependabot)\b[^.;,]{0,30}\b(?:disabled|off|not enabled)\b`, "i") },
    ],
  },
];

/** At most this many items per snapshot list. */
export const SNAPSHOT_LIST_CAP = 200;
/** At most this many characters per snapshot text. */
export const SNAPSHOT_TEXT_CAP = 2000;

export type PolicyStatus = "complete" | "incomplete" | "missing";
export type GapState = "accepted" | "deferred" | "unaccepted";

/** What a contract's daily scanner saw in one repo, stored as `contract_status.snapshot`. */
export interface ContractStatusSnapshot {
  policy: { status: PolicyStatus; path: string | null; missingRules: string[] };
  /** Known gaps, with the state `resolveGapStates` gave each on the scan. */
  gaps: { text: string; state: GapState }[];
  /** Drift findings, after `suppressListed`. */
  drift: DriftFinding[];
  /** Drift rules that could not run, as `rule: reason`. */
  driftUnavailable: string[];
  /** Stored audit findings after suppression and staleness; null when there is no audit. */
  audit: { findings: DriftFinding[]; auditedAt: string; sha: string } | null;
}

function capText(text: string): string {
  return text.length > SNAPSHOT_TEXT_CAP ? `${text.slice(0, SNAPSHOT_TEXT_CAP - 1)}…` : text;
}

function capFinding(f: DriftFinding): DriftFinding {
  return {
    rule: capText(f.rule),
    key: capText(f.key),
    message: capText(f.message),
    ...(f.file !== undefined ? { file: capText(f.file) } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
  };
}

/** A snapshot from what a scanner computed, capped at `SNAPSHOT_LIST_CAP` items per list and `SNAPSHOT_TEXT_CAP` characters per text. */
export function buildSnapshot(input: {
  policy: { status: PolicyStatus; path: string | null; missingRules: readonly string[] };
  /** Gaps already passed through `resolveGapStates`. */
  gaps: readonly { text: string; state: GapState }[];
  drift: readonly DriftFinding[];
  driftUnavailable: readonly string[];
  audit: { findings: readonly DriftFinding[]; auditedAt: string; sha: string } | null;
}): ContractStatusSnapshot {
  const cap = <T>(items: readonly T[]): T[] => items.slice(0, SNAPSHOT_LIST_CAP);
  return {
    policy: { status: input.policy.status, path: input.policy.path, missingRules: cap(input.policy.missingRules).map(capText) },
    gaps: cap(input.gaps).map((g) => ({ text: capText(g.text), state: g.state })),
    drift: cap(input.drift).map(capFinding),
    driftUnavailable: cap(input.driftUnavailable).map(capText),
    audit: input.audit
      ? { findings: cap(input.audit.findings).map(capFinding), auditedAt: input.audit.auditedAt, sha: input.audit.sha }
      : null,
  };
}

/**
 * Saves `snapshot` as the latest status of `repo` under `contract` and logs
 * `contract status saved`. A failed save logs `warn` and does not throw, so
 * the scanner's follow-up refresh still runs.
 */
export async function saveContractSnapshot(
  component: string,
  contract: ContractName,
  repo: string,
  snapshot: ContractStatusSnapshot,
): Promise<void> {
  try {
    await db.saveContractStatus(contract, repo, new Date().toISOString(), snapshot);
  } catch (err) {
    log.warn("contract status save failed", {
      component,
      repo,
      contract,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  log.info("contract status saved", {
    component,
    repo,
    contract,
    policy: snapshot.policy.status,
    ...gapCounts(snapshot),
    drift: snapshot.drift.length,
    audit: snapshot.audit?.findings.length ?? 0,
  });
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asFindings(v: unknown): DriftFinding[] {
  if (!Array.isArray(v)) return [];
  const out: DriftFinding[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue;
    const f = item as Record<string, unknown>;
    const rule = asString(f["rule"]);
    const key = asString(f["key"]);
    const message = asString(f["message"]);
    if (rule === null || key === null || message === null) continue;
    out.push({
      rule,
      key,
      message,
      ...(typeof f["file"] === "string" ? { file: f["file"] } : {}),
      ...(typeof f["line"] === "number" ? { line: f["line"] } : {}),
    });
  }
  return out;
}

/** A stored snapshot narrowed back to `ContractStatusSnapshot`, or null when it has no valid policy status. */
export function parseSnapshot(raw: unknown): ContractStatusSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const policy = r["policy"] as Record<string, unknown> | undefined;
  const status = policy?.["status"];
  if (status !== "complete" && status !== "incomplete" && status !== "missing") return null;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
  const gaps = Array.isArray(r["gaps"])
    ? (r["gaps"] as unknown[]).flatMap((g) => {
      if (typeof g !== "object" || g === null) return [];
      const text = asString((g as Record<string, unknown>)["text"]);
      const state = (g as Record<string, unknown>)["state"];
      if (text === null || typeof state !== "string") return [];
      // A state this build does not know (or a future one) counts as unaccepted.
      const known: GapState = state === "accepted" || state === "deferred" ? state : "unaccepted";
      return [{ text, state: known }];
    })
    : [];
  const auditRaw = r["audit"] as Record<string, unknown> | null | undefined;
  const auditedAt = asString(auditRaw?.["auditedAt"]);
  const sha = asString(auditRaw?.["sha"]);
  return {
    policy: { status, path: asString(policy?.["path"]), missingRules: strings(policy?.["missingRules"]) },
    gaps,
    drift: asFindings(r["drift"]),
    driftUnavailable: strings(r["driftUnavailable"]),
    audit: auditRaw && auditedAt !== null && sha !== null ? { findings: asFindings(auditRaw["findings"]), auditedAt, sha } : null,
  };
}

/** Why a repo is opted out of a contract: the disabled job and which config disables it. */
export interface OptOut {
  job: string;
  source: "repo" | "host";
}

/**
 * The first of `names` disabled for the repo, preferring its own `claws.json`
 * (`repoDisabled`) over the host config (`hostDisabled`); null when none is.
 */
export function optOutFor(names: readonly string[], hostDisabled: readonly string[], repoDisabled: readonly string[]): OptOut | null {
  for (const job of names) if (repoDisabled.includes(job)) return { job, source: "repo" };
  for (const job of names) if (hostDisabled.includes(job)) return { job, source: "host" };
  return null;
}

/** The job names that opt a repo out of `spec`'s scanner: its name, its aliases and `scanner-dispatcher`. */
export function optOutJobs(spec: ContractSpec): string[] {
  return [spec.scannerJob, ...spec.aliases, SCANNER_DISPATCHER];
}

/**
 * The contract-level requirements an accepted gap's text waives. An explicit
 * marker, `(waives: Metrics endpoint, Dashboard)`, wins; otherwise each
 * requirement's pattern must see the requirement being absent (a negation next
 * to its noun), so a gap that merely mentions a keyword is not a waiver.
 * Highlighting only: never used for counts or issue filing.
 */
export function contractRequirementsWaived(contract: string, gapText: string): string[] {
  const spec = CONTRACTS.find((c) => c.contract === contract);
  if (!spec) return [];
  const marker = /\bwaives:\s*([^)\n]+)/i.exec(gapText);
  if (marker) {
    const wanted = marker[1]!.split(",").map((w) => w.trim().toLowerCase().replace(/[\s_-]+/g, " "));
    const named = spec.requirements
      .filter((r) => wanted.includes(r.label.toLowerCase().replace(/[\s_-]+/g, " ")))
      .map((r) => r.label);
    // A marker naming no known label falls through to the pattern test.
    if (named.length > 0) return named;
  }
  return spec.requirements.filter((r) => r.pattern.test(gapText)).map((r) => r.label);
}

/** One repo's standing against one contract, as `/contracts` shows it. */
export interface ContractRow {
  repo: string;
  contract: ContractName;
  optOut: OptOut | null;
  /** The latest scanner snapshot; null when never scanned (or the stored one is corrupt). */
  snapshot: ContractStatusSnapshot | null;
  /** When the scanner last saved a snapshot, ISO 8601. */
  scannedAt: string | null;
  /** When the contract was last audited, ISO 8601; null when never or the contract has no audit. */
  auditedAt: string | null;
  /** The contract's audit job is disabled for the repo. */
  auditOff: boolean;
  /** The contract has an audit job at all. */
  audited: boolean;
  followUp: { id: string; title: string; stopsAt: string | null } | null;
}

export interface ContractRowsInput {
  /** Managed repos' full names; stored rows for any other repo are ignored. */
  repos: readonly string[];
  statuses: readonly { contract: string; repo: string; scannedAt: string; snapshot: unknown }[];
  auditTimes: readonly { contract: string; repo: string; auditedAt: string }[];
  followUps: readonly { contract: string; repo: string; id: string; title: string; stopsAt: string | null }[];
  exclusions: readonly { repo: string; job: string; hostDisabled: boolean; repositoryDisabled: boolean }[];
}

/** One row per managed repo and contract. */
export function buildContractRows(input: ContractRowsInput): ContractRow[] {
  const key = (contract: string, repo: string): string => `${contract}\u0000${repo}`;
  const statuses = new Map(input.statuses.map((s) => [key(s.contract, s.repo), s]));
  const audits = new Map(input.auditTimes.map((a) => [key(a.contract, a.repo), a.auditedAt]));
  const followUps = new Map<string, ContractRowsInput["followUps"][number]>();
  for (const f of input.followUps) if (!followUps.has(key(f.contract, f.repo))) followUps.set(key(f.contract, f.repo), f);
  const host = new Map<string, string[]>();
  const repoCfg = new Map<string, string[]>();
  for (const e of input.exclusions) {
    if (e.hostDisabled) host.set(e.repo, [...(host.get(e.repo) ?? []), e.job]);
    if (e.repositoryDisabled) repoCfg.set(e.repo, [...(repoCfg.get(e.repo) ?? []), e.job]);
  }
  const rows: ContractRow[] = [];
  for (const repo of input.repos) {
    const hostDisabled = host.get(repo) ?? [];
    const repoDisabled = repoCfg.get(repo) ?? [];
    for (const spec of CONTRACTS) {
      const stored = statuses.get(key(spec.contract, repo));
      const followUp = followUps.get(key(spec.contract, repo));
      rows.push({
        repo,
        contract: spec.contract,
        optOut: optOutFor(optOutJobs(spec), hostDisabled, repoDisabled),
        snapshot: stored ? parseSnapshot(stored.snapshot) : null,
        scannedAt: stored?.scannedAt ?? null,
        auditedAt: spec.auditJob ? audits.get(key(spec.contract, repo)) ?? null : null,
        auditOff: spec.auditJob !== null && optOutFor([spec.auditJob], hostDisabled, repoDisabled) !== null,
        audited: spec.auditJob !== null,
        followUp: followUp ? { id: followUp.id, title: followUp.title, stopsAt: followUp.stopsAt } : null,
      });
    }
  }
  return rows;
}

/** Unaccepted, deferred and accepted gap counts of a snapshot. */
export function gapCounts(snapshot: ContractStatusSnapshot): { unaccepted: number; deferred: number; accepted: number } {
  return {
    unaccepted: snapshot.gaps.filter((g) => g.state === "unaccepted").length,
    deferred: snapshot.gaps.filter((g) => g.state === "deferred").length,
    accepted: snapshot.gaps.filter((g) => g.state === "accepted").length,
  };
}

/** A row needs attention: an incomplete or missing policy, or any unaccepted gap, drift or audit finding; deferred gaps do not count. */
export function needsAttention(row: ContractRow): boolean {
  if (row.optOut || !row.snapshot) return false;
  const s = row.snapshot;
  return s.policy.status !== "complete" || gapCounts(s).unaccepted > 0 || s.drift.length > 0 || (s.audit?.findings.length ?? 0) > 0;
}

/** Rows needing attention first, then by repo and contract; opted-out rows last. */
export function orderContractRows(rows: readonly ContractRow[]): ContractRow[] {
  const rank = (r: ContractRow): number => (r.optOut ? 2 : needsAttention(r) ? 0 : 1);
  return [...rows].sort((a, b) =>
    rank(a) - rank(b) || a.repo.localeCompare(b.repo) || a.contract.localeCompare(b.contract));
}

/** One waived contract-level requirement and the repos whose accepted gaps waive it. */
export interface ContractWaiver {
  contract: ContractName;
  requirement: string;
  repos: string[];
}

/** Every requirement an accepted gap waives across `rows` (opted-out rows excluded), in registry order. */
export function contractWaivers(rows: readonly ContractRow[]): ContractWaiver[] {
  const out: ContractWaiver[] = [];
  for (const spec of CONTRACTS) {
    for (const req of spec.requirements) {
      const repos = new Set<string>();
      for (const row of rows) {
        if (row.contract !== spec.contract || row.optOut || !row.snapshot) continue;
        if (row.snapshot.gaps.some((g) => g.state === "accepted" && contractRequirementsWaived(row.contract, g.text).includes(req.label))) repos.add(row.repo);
      }
      if (repos.size > 0) out.push({ contract: spec.contract, requirement: req.label, repos: [...repos].sort() });
    }
  }
  return out;
}
