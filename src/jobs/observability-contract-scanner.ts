import fs from "node:fs";
import path from "node:path";
import { type Repo } from "../config.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { mapSettledWithConcurrency } from "../util.js";
import {
  ACCEPTED_GAP_PREFIX,
  DEFERRED_GAP_FORMS,
  KNOWN_GAPS_HEADING,
  NO_TELEMETRY_SENTENCE,
  OBSERVABILITY_CONTRACT_MARKDOWN,
  OBSERVABILITY_DOC_PATHS,
  OBSERVABILITY_PLACEHOLDER,
  OBSERVABILITY_RULES,
  findObservabilitySection,
  missingLoggingRules,
  missingObservabilityRules,
  parseKnownGaps,
  type KnownGap,
  type ObservabilityRule,
} from "../observability-contract.js";
import * as db from "../db.js";
import {
  isBackfillOnly,
  logBackfillSummary,
  refreshFollowUpIssue,
  resolveGapStates,
  storedAuditFindings,
  toBackfillRules,
  type BackfillRule,
} from "../contract-drift.js";
import {
  KNOWN_GAPS_DEDUPE_KEY,
  OBSERVABILITY_AUDIT,
  OBSERVABILITY_CONTRACT_DOC_URL,
  readObservabilityPolicy,
} from "../observability-audit.js";
import { findConsoleCalls, isService, packageDeps, readPackageJson, serviceSignals } from "../observability-evidence.js";
import { detectObservabilityDrift, type InfraClones } from "../observability-drift.js";
import { runRepoScanner, type ScannerSpec } from "./scanner-runner.js";
import { buildSnapshot, saveContractSnapshot, type PolicyStatus } from "../contract-status.js";

const NAME = "observability-contract-scanner";
// Frozen: this exact title is the findIssueByExactTitle dedupe key. Changing it
// orphans every open issue and files a duplicate in every non-compliant repo.
const ISSUE_TITLE = "chore: declare this repo's observability policy";
// The logging-only scanner's title; an open issue under it is retitled and rewritten in place.
const LEGACY_ISSUE_TITLES = ["chore: adopt the structured logging contract"];

// The per-repo follow-up for unaccepted Known gaps, keyed so daily scans rewrite it
// instead of re-filing; its identity is shared with the contract-audit job.
export { KNOWN_GAPS_DEDUPE_KEY };
const GAP_CONCURRENCY = 4;

const CONTRACT_DOC_URL = OBSERVABILITY_CONTRACT_DOC_URL;

const LOGGER_DEPS = ["pino", "winston", "bunyan"];
const MAX_FILES_READ = 400;
const MAX_SAMPLE_PATHS = 5;

interface ObservabilityEvidence {
  /** Service detection is a hint for the body's wording, never a gate. */
  service: boolean;
  serviceSignals: string[];
  loggerDeps: string[];
  /** Repo-relative path of the doc whose policy was checked, or null when none has one. */
  policyPath: string | null;
  missingRules: readonly ObservabilityRule[];
  /** True when some accepted doc already satisfies every logging rule. */
  loggingSatisfied: boolean;
  /** Policy docs that exist but have no policy heading, so a maintainer edits them rather than adding a duplicate. */
  docsWithoutSection: string[];
  consoleCalls: number;
  consoleSamples: string[];
  frameworkDefault: string | null;
}

/** The first accepted doc whose policy covers every contract rule, else the doc with the most
 *  complete policy (path null when no doc has one at all), plus whether any doc already satisfies
 *  the logging rules, the docs that exist but have no policy heading, and the rules no doc
 *  satisfies (`unsatisfied`, which counts a policy split across docs as one). */
function checkPolicyDocs(repoDir: string): {
  compliant: boolean;
  path: string | null;
  missing: readonly ObservabilityRule[];
  loggingSatisfied: boolean;
  withoutSection: string[];
  unsatisfied: readonly ObservabilityRule[];
} {
  let best: { path: string | null; missing: readonly ObservabilityRule[] } = { path: null, missing: OBSERVABILITY_RULES };
  let loggingSatisfied = false;
  // Rules met by some doc, so a policy split across docs (logging in
  // docs/logging.md, the rest in AGENTS.md) still counts as complete.
  const satisfied = new Set<string>();
  // failsWhenPresent rules some doc with a policy section fails (e.g. a leftover placeholder).
  const presentFailures = new Set<string>();
  const withoutSection: string[] = [];
  for (const doc of OBSERVABILITY_DOC_PATHS) {
    const abs = path.join(repoDir, doc.path);
    if (!fs.existsSync(abs)) continue;
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const missing = missingObservabilityRules(text, { wholeDocument: doc.wholeDocument });
    if (missing.length === 0) {
      return { compliant: true, path: doc.path, missing, loggingSatisfied: true, withoutSection, unsatisfied: [] };
    }
    const hasSection =
      doc.wholeDocument || findObservabilitySection(text) !== null || text.includes(OBSERVABILITY_CONTRACT_MARKDOWN);
    const missingIds = new Set(missing.map((r) => r.id));
    for (const r of OBSERVABILITY_RULES) {
      if (r.failsWhenPresent) {
        if (hasSection && missingIds.has(r.id)) presentFailures.add(r.id);
      } else if (!missingIds.has(r.id)) satisfied.add(r.id);
    }
    if (missing.every((r) => r.area !== "logging") || missingLoggingRules(text).length === 0) loggingSatisfied = true;
    if (!doc.wholeDocument && findObservabilitySection(text) === null && !text.includes(OBSERVABILITY_CONTRACT_MARKDOWN)) {
      withoutSection.push(doc.path);
      continue;
    }
    if (best.path === null || missing.length < best.missing.length) best = { path: doc.path, missing };
  }
  const unsatisfied = OBSERVABILITY_RULES.filter((r) => (r.failsWhenPresent ? presentFailures.has(r.id) : !satisfied.has(r.id)));
  if (unsatisfied.length === 0) {
    return { compliant: true, path: best.path, missing: [], loggingSatisfied: true, withoutSection, unsatisfied };
  }
  return { compliant: false, ...best, loggingSatisfied, withoutSection, unsatisfied };
}

function countConsoleCalls(repoDir: string, evidence: ObservabilityEvidence): void {
  for (const site of findConsoleCalls(repoDir, { maxDepth: 5, maxFiles: MAX_FILES_READ })) {
    evidence.consoleCalls += site.count;
    if (evidence.consoleSamples.length < MAX_SAMPLE_PATHS) evidence.consoleSamples.push(site.file);
  }
}

function frameworkDefaultLogging(deps: Record<string, string>, hasLogger: boolean): string | null {
  if ("next" in deps) return "`next` (Next.js default text output)";
  if (hasLogger) return null;
  if ("morgan" in deps) return "`morgan` access lines with no structured logger";
  if ("express" in deps) return "`express` with no structured logger";
  return null;
}

function formatIssueBody(evidence: ObservabilityEvidence): string {
  const lines: string[] = [
    "This repo has not declared a complete observability policy under the St-John-Software observability contract: what it logs, which metrics and traces it emits, its latency budgets, its Grafana dashboard (or why it has none), and what each new route, DB query, background job or external call must add. Every managed repo declares one, or states that it emits no runtime telemetry.",
    "",
    "**Evidence:**",
    "",
    evidence.service
      ? `- Runnable service detected: ${evidence.serviceSignals.join("; ")}`
      : `- No runnable service detected, so declare analytics/uptime or the no-telemetry sentence (\`${NO_TELEMETRY_SENTENCE}\`)`,
  ];

  if (evidence.service) {
    lines.push(
      evidence.loggerDeps.length > 0
        ? `- Structured logger dependency present: ${evidence.loggerDeps.map((d) => `\`${d}\``).join(", ")}`
        : "- No structured logger dependency (`pino`, `winston` or `bunyan`) in `package.json`",
    );
  }

  if (evidence.policyPath) {
    lines.push(`- \`${evidence.policyPath}\` has an observability policy, but it is incomplete`);
  }
  for (const rel of evidence.docsWithoutSection) {
    lines.push(`- \`${rel}\` exists but has no observability or logging section`);
  }
  if (!evidence.policyPath) {
    const absent = OBSERVABILITY_DOC_PATHS.map((d) => d.path).filter((rel) => !evidence.docsWithoutSection.includes(rel));
    if (absent.length > 0) lines.push(`- No ${absent.map((rel) => `\`${rel}\``).join(" and no ")}`);
  }

  if (evidence.service) {
    if (evidence.consoleCalls > 0) {
      lines.push(
        `- ${evidence.consoleCalls} direct \`console.*\` call site(s) in service code, e.g.:`,
        ...evidence.consoleSamples.map((p) => `  - \`${p}\``),
      );
    } else {
      lines.push("- No direct `console.*` call sites found in service code");
    }
    if (evidence.frameworkDefault) {
      lines.push(`- Framework default logging in play: ${evidence.frameworkDefault}`);
    }
  }

  const missingLogging = evidence.loggingSatisfied ? [] : evidence.missingRules.filter((r) => r.area === "logging");
  const missingObservability = evidence.missingRules.filter((r) => r.area === "observability");
  lines.push("", "**Logging rules:**", "");
  if (missingLogging.length === 0) {
    lines.push("- Logging already satisfied — nothing to change there.");
  } else {
    lines.push(...missingLogging.map((r) => `- ${r.label}`));
  }
  lines.push("", "**Observability sections:**", "");
  if (missingObservability.length === 0) {
    lines.push("- All present.");
  } else {
    lines.push(...missingObservability.map((r) => `- ${r.label}`));
  }

  if (evidence.policyPath) {
    lines.push(
      "",
      `**Check the policy against the code.** \`${evidence.policyPath}\` already declares a policy, so this is not a rewrite: verify every statement it makes about current logging, metrics, traces, latency budgets and dashboards/alerts against this repo's code and config (the logger module, metrics endpoint, tracing SDK, and the dashboard and alert files), correct any the code does not support, word rules for future changes as rules for new changes, and add the \`${KNOWN_GAPS_HEADING}\` section.`,
    );
  }

  lines.push(
    "",
    "**Asks:**",
    "",
    `- [ ] Add the starter template below as \`docs/observability.md\` (or as an \`## Observability\` section in \`AGENTS.md\`) and replace every \`${OBSERVABILITY_PLACEHOLDER}\` line with this repo's answer — or, if the repo has nothing to observe, replace the subsections with the line \`${NO_TELEMETRY_SENTENCE}\`.`,
  );
  lines.push(
    `- [ ] Check every current-behaviour statement in the policy against the code, and add a \`${KNOWN_GAPS_HEADING}\` section listing each place existing code falls short of the contract or of the policy's own per-change rules (one list item each, or \`None.\`); start an accepted gap's item with \`${ACCEPTED_GAP_PREFIX} <reason>\`, and a gap the repo cannot fix yet with ${DEFERRED_GAP_FORMS}. For the unaccepted gaps the daily scan files one follow-up issue (dedupe key \`${KNOWN_GAPS_DEDUPE_KEY}\`), titled after the items it lists.`,
  );
  if (evidence.service && missingLogging.length > 0) {
    lines.push(
      "- [ ] Add a shared logger module wrapping pino per the reference implementation below (string `level`, ISO `time`, `service`/`component` base fields, `err` serializer).",
      "- [ ] Replace direct `console.*` calls in service code with the shared logger.",
    );
  }
  lines.push(
    "",
    "````markdown",
    OBSERVABILITY_CONTRACT_MARKDOWN,
    "````",
    "",
    `Canonical contract, accepted locations and LogQL query examples: ${CONTRACT_DOC_URL}`,
    "",
    "---",
    "",
    `If this repo intentionally does not follow the observability contract, this check can be turned off via the \`${NAME}\` job-disable config for this repo rather than by closing this issue — an open issue with the exact title above will otherwise be re-filed on the next daily scan.`,
  );

  return lines.join("\n");
}

/** Dated rules an existing policy fails when it fails no undated rule; empty otherwise. */
function backfillOnlyRules(docs: ReturnType<typeof checkPolicyDocs>): BackfillRule[] {
  return docs.path !== null && isBackfillOnly(docs.unsatisfied) ? toBackfillRules(docs.unsatisfied) : [];
}

function scan(repoDir: string): { body: string; summary?: string } | null {
  const docs = checkPolicyDocs(repoDir);
  if (docs.compliant) return null;
  // An existing policy failing only dated rules gets them in the known-gaps follow-up instead.
  if (backfillOnlyRules(docs).length > 0) return null;

  const pkg = readPackageJson(repoDir);
  const deps = packageDeps(pkg);
  const service = isService(repoDir, pkg, deps);
  const loggerDeps = LOGGER_DEPS.filter((d) => d in deps);
  const evidence: ObservabilityEvidence = {
    service,
    serviceSignals: service ? serviceSignals(repoDir, pkg, deps) : [],
    loggerDeps,
    policyPath: docs.path,
    missingRules: docs.missing,
    loggingSatisfied: docs.loggingSatisfied,
    docsWithoutSection: docs.withoutSection,
    consoleCalls: 0,
    consoleSamples: [],
    frameworkDefault: frameworkDefaultLogging(deps, loggerDeps.length > 0),
  };
  if (service) countConsoleCalls(repoDir, evidence);

  return {
    body: formatIssueBody(evidence),
    summary: service ? "service repo without a complete observability policy" : "repo without a complete observability policy",
  };
}

const SPEC: ScannerSpec = {
  name: NAME,
  issueTitle: ISSUE_TITLE,
  legacyIssueTitles: LEGACY_ISSUE_TITLES,
  scan,
};

const FLEET_INFRA = "St-John-Software/fleet-infra";
const PRODUCTION_INFRA = "St-John-Software/production-infra";

/** Local clone dir of an infra repo, or null when it has not been cloned. */
function infraCloneDir(fullName: string): string | null {
  const [owner, name] = fullName.split("/") as [string, string];
  const dir = claude.repoDir({ owner, name, fullName, defaultBranch: "main" });
  return fs.existsSync(dir) ? dir : null;
}

/** The `/contracts` policy status from a policy-docs check: complete, incomplete (with the missing rules) or missing. */
function policyStatus(docs: ReturnType<typeof checkPolicyDocs>): { status: PolicyStatus; path: string | null; missingRules: string[] } {
  if (docs.compliant) return { status: "complete", path: docs.path, missingRules: [] };
  return { status: docs.path ? "incomplete" : "missing", path: docs.path, missingRules: docs.missing.map((r) => r.label) };
}

/**
 * Saves the repo's `/contracts` snapshot, then checks its policy against its
 * code with the observability drift rules, then files or rewrites its one
 * follow-up issue (keyed `KNOWN_GAPS_DEDUPE_KEY`) for the unaccepted Known
 * gaps (deferred ones skipped while their deferral holds), the drift found, the latest stored contract-audit findings, and the
 * dated contract rules it fails when it fails no undated one.
 * When a rule cannot read a dependency the follow-up is left untouched this
 * run and the failure is reported. Returns every dated rule the policy fails,
 * for the fleet summary.
 */
async function fileKnownGapIssue(
  repo: Repo,
  infra: InfraClones | null,
  repoClones?: ReadonlyMap<string, string | null>,
): Promise<BackfillRule[]> {
  const repoDir = claude.repoDir(repo);
  if (!fs.existsSync(repoDir)) return [];
  const docs = checkPolicyDocs(repoDir);
  const status = policyStatus(docs);
  const failingDated = docs.path !== null ? toBackfillRules(docs.unsatisfied) : [];
  const newRules = backfillOnlyRules(docs);
  const read = readObservabilityPolicy(repoDir);
  const policy = read ?? (newRules.length > 0 && docs.path !== null ? { path: docs.path, text: "" } : null);
  if (!policy) {
    await saveContractSnapshot(NAME, "observability", repo.fullName,
      buildSnapshot({ policy: status, gaps: [], drift: [], driftUnavailable: [], audit: null }));
    return failingDated;
  }
  const allGaps = parseKnownGaps(policy.text) ?? [];
  const resolved = await resolveGapStates(allGaps, new Date(), { component: NAME, repo: repo.fullName });
  const gaps = resolved.filter((g) => g.state === "unaccepted");
  const drift = read
    ? detectObservabilityDrift(repoDir, policy.text, infra, repoClones)
    : { findings: [], suppressed: 0, excepted: 0, unavailable: [] };
  const stored = await storedAuditFindings(OBSERVABILITY_AUDIT, NAME, repo, repoDir, allGaps);
  const { audit, stale } = stored;
  await saveContractSnapshot(NAME, "observability", repo.fullName, buildSnapshot({
    policy: status,
    gaps: resolved,
    drift: drift.findings,
    driftUnavailable: drift.unavailable.map((u) => `${u.rule}: ${u.reason}`),
    audit,
  }));
  log.info("drift check finished", {
    component: NAME,
    repo: repo.fullName,
    gaps: gaps.length,
    deferred: resolved.filter((g) => g.state === "deferred").length,
    drift: drift.findings.length,
    suppressed: drift.suppressed + stored.suppressed,
    excepted: drift.excepted + stored.excepted,
    unavailable: drift.unavailable.length,
    audit: audit?.findings.length ?? 0,
    audit_stale: stale,
  });
  if (drift.unavailable.length > 0) {
    const reasons = drift.unavailable.map((u) => `${u.rule}: ${u.reason}`).join("; ");
    await reportError(`${NAME}:drift-unavailable`, repo.fullName, new Error(`Drift check could not run: ${reasons}`), {
      repo: repo.fullName,
    });
    return failingDated;
  }

  let headSha: string | null = null;
  if (audit) try {
    headSha = (await claude.git(["rev-parse", `origin/${repo.defaultBranch}`], repoDir, { maxRetries: 0 })).trim() || null;
  } catch {
    headSha = null;
  }
  await refreshFollowUpIssue({
    job: NAME,
    repo: repo.fullName,
    dedupeKey: KNOWN_GAPS_DEDUPE_KEY,
    contract: "observability",
    policyPath: policy.path,
    gaps,
    drift: drift.findings,
    audit,
    headSha,
    contractDocUrl: CONTRACT_DOC_URL,
    newRules,
  });
  return failingDated;
}

async function fileKnownGapIssues(repos: Repo[]): Promise<void> {
  const fleetInfra = infraCloneDir(FLEET_INFRA);
  const productionInfra = infraCloneDir(PRODUCTION_INFRA);
  const infra = fleetInfra || productionInfra ? { fleetInfra, productionInfra } : null;
  const repoClones = new Map<string, string | null>();
  for (const r of repos) {
    const dir = claude.repoDir(r);
    repoClones.set(r.name.toLowerCase(), fs.existsSync(dir) ? dir : null);
  }
  const failing = new Map<string, readonly BackfillRule[]>();
  await mapSettledWithConcurrency(repos, GAP_CONCURRENCY, async (repo) => {
    try {
      const dated = await fileKnownGapIssue(repo, infra, repoClones);
      if (dated.length > 0) failing.set(repo.fullName, dated);
    } catch (err) {
      await reportError(`${NAME}:known-gaps`, repo.fullName, err, { repo: repo.fullName });
    }
  });
  logBackfillSummary(NAME, "observability", failing);
}

export async function run(repos: Repo[]): Promise<void> {
  await runRepoScanner(SPEC, repos);
  await fileKnownGapIssues(repos);
}
