/**
 * The observability contract's `ContractAuditSpec`: how the weekly
 * `contract-audit` agent job reads a repo's observability policy, what it asks
 * the agent to check (recent changes against the policy's "What every change
 * adds" rules), and how it parses the agent's findings. Also owns the policy
 * reader and follow-up issue identity the daily `observability-contract-scanner`
 * shares, so the scanner and the audit agree on which doc is the policy.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ContractAuditSpec, ContractPolicy, DriftFinding } from "./contract-drift.js";
import { parseFirstValidJson } from "./json-extract.js";
import {
  ACCEPTED_GAP_PREFIX,
  KNOWN_GAPS_HEADING,
  NO_TELEMETRY_SENTENCE,
  OBSERVABILITY_DOC_PATHS,
  findObservabilitySection,
  type KnownGap,
} from "./observability-contract.js";

// The per-repo follow-up for unaccepted Known gaps and drift/audit findings: one native
// issue per repo, keyed so daily scans rewrite it instead of re-filing.
export const KNOWN_GAPS_ISSUE_TITLE = "chore: close this repo's known observability gaps";
export const KNOWN_GAPS_DEDUPE_KEY = "observability-known-gaps";

export const OBSERVABILITY_CONTRACT_DOC_URL =
  "https://git.home.bstjohn.net/St-John-Software/claws/src/branch/main/docs/observability-contract.md";

/** Rule id stamped on every finding the audit agent reports. */
export const OBSERVABILITY_AUDIT_RULE = "observability-audit";

/** The repo's declared observability policy text and its path; null when no accepted doc has one. */
export function readObservabilityPolicy(repoDir: string): ContractPolicy | null {
  for (const doc of OBSERVABILITY_DOC_PATHS) {
    const abs = path.join(repoDir, doc.path);
    if (!fs.existsSync(abs)) continue;
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const policy = doc.wholeDocument ? text : findObservabilitySection(text);
    if (policy !== null) return { path: doc.path, text: policy };
  }
  return null;
}

const FINDINGS_SCHEMA = z.object({
  findings: z.array(
    z.object({
      file: z.string().min(1),
      line: z.number().int().positive().nullish(),
      claim: z.string().min(1),
      evidence: z.string().min(1),
    }),
  ),
});

/**
 * The agent's findings as `DriftFinding`s keyed by file, or null when the
 * output holds no schema-valid `{"findings":[...]}` object.
 */
export function parseObservabilityAuditFindings(
  output: string,
  onFailure?: (err: unknown, candidates: string[]) => void,
): DriftFinding[] | null {
  const parsed = parseFirstValidJson(output, FINDINGS_SCHEMA, "contract-audit", onFailure);
  if (!parsed) return null;
  return parsed.findings.map((f) => {
    const file = f.file.replace(/^\.\//, "");
    return {
      rule: OBSERVABILITY_AUDIT_RULE,
      key: file,
      file,
      ...(typeof f.line === "number" ? { line: f.line } : {}),
      message: `The policy says ${f.claim.trim().replace(/\.$/, "")}; the code shows ${f.evidence.trim().replace(/\.$/, "")}.`,
    };
  });
}

/**
 * The audit prompt: the policy, its Known gaps, and the `git log --stat` of
 * the changes since the last audit (or of the last 50 commits on a first
 * audit), with the instruction to report only concrete per-change mismatches.
 */
export function buildObservabilityAuditPrompt(
  policy: ContractPolicy,
  sinceSha: string | null,
  knownGaps: readonly KnownGap[],
  gitLog: string,
): string {
  const range = sinceSha ? `\`git log --stat ${sinceSha}..HEAD\` (every change since the last audit)` : "`git log --stat -50` (the last 50 commits; this is the repo's first audit)";
  const gaps = knownGaps.length > 0 ? knownGaps.map((g) => `- ${g.text}`).join("\n") : "None.";
  return [
    "You are auditing this repository against its own declared observability policy. This is a read-only audit: inspect freely, but do not modify, stage, commit or push anything, and do not file issues.",
    "",
    `The policy lives in \`${policy.path}\`:`,
    "",
    "<policy>",
    policy.text.trim(),
    "</policy>",
    "",
    `Its \`${KNOWN_GAPS_HEADING}\` items (accepted ones start \`${ACCEPTED_GAP_PREFIX}\`). Never report anything one of these already covers:`,
    "",
    "<known_gaps>",
    gaps,
    "</known_gaps>",
    "",
    `The changes to audit, from ${range}:`,
    "",
    "<git_log>",
    gitLog.trim() || "(no commits)",
    "</git_log>",
    "",
    "Task:",
    "",
    "1. From the changes above, find each new HTTP route, DB query, background job, external call, state-changing action and `error`/`fatal` log path. Read the code with `git show` and the files themselves; work only from what changed in this range.",
    "2. Check each one against the policy's \"What every change adds\" rules (and its logging, level and shipping rules): the access log line, metric, `duration_ms` log line or span, start/finish lines, `info` line, constant `msg`, dashboard panel or alert the policy says such a change must add.",
    "3. Dashboards and alert rules live in other repos. Read them over the Forgejo API with the read-only token in your environment, never by guessing: `curl -sH \"Authorization: token $CLAWS_FORGEJO_READ_TOKEN\" \"$CLAWS_FORGEJO_BASE_URL/api/v1/repos/St-John-Software/fleet-infra/raw/apps/monitoring/...\"` (or `St-John-Software/production-infra` under `infrastructure/prod/observability/`), and `contents/DIR` to list a directory.",
    "",
    "Report only concrete mismatches between a rule the policy states and code in this repo, each with the repo-relative file and 1-based line that shows it. Do not report style, naming, missing tests, suggestions, rules the policy does not state, or anything listed under Known gaps. When nothing is wrong, report no findings.",
    "",
    "End your reply with exactly one JSON object, in a ```json fence, of this shape:",
    "",
    "```json",
    '{"findings":[{"file":"src/server.ts","line":42,"claim":"every new HTTP route logs an access line with duration_ms","evidence":"GET /api/widgets added in abc1234 logs nothing"}]}',
    "```",
    "",
    '`claim` is the policy rule, `evidence` is what the code shows. Use `{"findings":[]}` when there are none.',
  ].join("\n");
}

/** The observability contract's audit spec, registered in `CONTRACT_AUDITS`. */
export const OBSERVABILITY_AUDIT: ContractAuditSpec = {
  contract: "observability",
  scannerJob: "observability-contract-scanner",
  readPolicy(repoDir) {
    const policy = readObservabilityPolicy(repoDir);
    if (!policy || policy.text.includes(NO_TELEMETRY_SENTENCE)) return null;
    return policy;
  },
  buildPrompt: buildObservabilityAuditPrompt,
  parseFindings: parseObservabilityAuditFindings,
  followUp: {
    title: KNOWN_GAPS_ISSUE_TITLE,
    dedupeKey: KNOWN_GAPS_DEDUPE_KEY,
    contractDocUrl: OBSERVABILITY_CONTRACT_DOC_URL,
  },
};
