/**
 * The security contract's `ContractAuditSpec`: how the weekly `contract-audit`
 * agent job reads a repo's security policy, what it asks the agent to check
 * (every current-behaviour claim in the policy against the code and the
 * deployment repos), and how it parses the agent's findings. Also owns the
 * policy reader and follow-up issue identity the daily
 * `security-contract-scanner` shares. This module must not import from
 * `src/jobs/`.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ContractAuditSpec, ContractPolicy, DriftFinding } from "./contract-drift.js";
import { CONTRACT_EXCEPTIONS_PATH, type ContractException } from "./contract-exceptions.js";
import { parseFirstValidJson } from "./json-extract.js";
import { ACCEPTED_GAP_PREFIX, DEFERRED_GAP_PREFIX, KNOWN_GAPS_HEADING, type KnownGap } from "./observability-contract.js";
import { SECURITY_DOC_PATHS, SECURITY_PLACEHOLDER, findSecuritySection } from "./security-contract.js";
import { SECURITY_AUDIT_RULE, readSecurityExceptions } from "./security-drift.js";

export { SECURITY_AUDIT_RULE };

// The per-repo follow-up for unaccepted Known gaps and drift/audit findings: one native
// issue per repo, keyed so daily scans rewrite it instead of re-filing; its title is
// built from the items it lists (`followUpTitle` in contract-drift.ts).
export const KNOWN_GAPS_DEDUPE_KEY = "security-known-gaps";

export const SECURITY_CONTRACT_DOC_URL =
  "https://git.home.bstjohn.net/St-John-Software/claws/src/branch/main/docs/security-contract.md";

/** Text of `rel` under `repoDir`; null when it is missing or unreadable. */
export function readDoc(repoDir: string, rel: string): string | null {
  const abs = path.join(repoDir, rel);
  if (!fs.existsSync(abs)) return null;
  try {
    return fs.readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

/** The repo's security policy text and its path; null when no accepted doc has one. */
export function readSecurityPolicy(repoDir: string): ContractPolicy | null {
  for (const doc of SECURITY_DOC_PATHS) {
    const text = readDoc(repoDir, doc.path);
    if (text === null) continue;
    const policy = doc.wholeDocument ? text : findSecuritySection(text);
    if (policy !== null) return { path: doc.path, text: policy };
  }
  return null;
}

const FINDINGS_SCHEMA = z.object({
  findings: z.array(
    z.object({
      repo: z.string().min(1).nullish(),
      file: z.string().min(1),
      line: z.number().int().positive().nullish(),
      claim: z.string().min(1),
      evidence: z.string().min(1),
    }),
  ),
});

/**
 * The agent's findings as `DriftFinding`s, or null when the output holds no
 * schema-valid `{"findings":[...]}` object. A finding in another repo (the
 * optional `repo` field) carries no `file` or `line`, so the local staleness
 * diff never touches it; its `key` is `<repo>:<path>`.
 */
export function parseSecurityAuditFindings(
  output: string,
  onFailure?: (err: unknown, candidates: string[]) => void,
): DriftFinding[] | null {
  const parsed = parseFirstValidJson(output, FINDINGS_SCHEMA, "contract-audit", onFailure);
  if (!parsed) return null;
  return parsed.findings.map((f) => {
    const file = f.file.replace(/^\.\//, "");
    const sentence = `The policy says ${f.claim.trim().replace(/\.$/, "")}; the code shows ${f.evidence.trim().replace(/\.$/, "")}.`;
    const repo = f.repo?.trim();
    if (repo) {
      const at = typeof f.line === "number" ? `${repo}:${file}:${f.line}` : `${repo}:${file}`;
      return { rule: SECURITY_AUDIT_RULE, key: `${repo}:${file}`, message: `\`${at}\`: ${sentence}` };
    }
    return {
      rule: SECURITY_AUDIT_RULE,
      key: file,
      file,
      ...(typeof f.line === "number" ? { line: f.line } : {}),
      message: sentence,
    };
  });
}

/**
 * The audit prompt: the policy, its Known gaps and the repo's scanner
 * exceptions, with the instruction to
 * check every current-behaviour claim against the code and the deployment
 * repos. The audit covers the whole policy each run, so `sinceSha` and
 * `gitLog` are ignored.
 */
export function buildSecurityAuditPrompt(
  policy: ContractPolicy,
  _sinceSha: string | null,
  knownGaps: readonly KnownGap[],
  _gitLog: string,
  exceptions: readonly ContractException[] = [],
): string {
  const gaps = knownGaps.length > 0 ? knownGaps.map((g) => `- ${g.text}`).join("\n") : "None.";
  const excepted =
    exceptions.length > 0
      ? exceptions.map((e) => `- rule \`${e.rule}\`,${e.finding ? ` finding \`${e.finding}\`,` : ""} keys ${e.keys.map((k) => `\`${k}\``).join(", ")}: ${e.reason}`).join("\n")
      : "None.";
  const fetchBase = '`curl -sH "Authorization: token $CLAWS_FORGEJO_READ_TOKEN" "$CLAWS_FORGEJO_BASE_URL/api/v1/repos/St-John-Software/<fleet-infra|production-infra>/raw/<path>"`';
  return [
    "You are auditing this repository against its own declared security policy. This is a read-only audit: inspect freely, but do not modify, stage, commit or push anything, and do not file issues.",
    "",
    `The policy lives in \`${policy.path}\`:`,
    "",
    "<policy>",
    policy.text.trim(),
    "</policy>",
    "",
    `Its \`${KNOWN_GAPS_HEADING}\` items (accepted ones start \`${ACCEPTED_GAP_PREFIX}\`, deferred ones \`${DEFERRED_GAP_PREFIX}\`). Never report anything one of these already covers:`,
    "",
    "<known_gaps>",
    gaps,
    "</known_gaps>",
    "",
    `Its scanner exceptions in \`${CONTRACT_EXCEPTIONS_PATH}\`: findings the repo recorded as wrong or not applicable, with the reason. Never report anything these cover. An entry with a finding id covers only the mismatch its reason describes, not the whole file:`,
    "",
    "<exceptions>",
    excepted,
    "</exceptions>",
    "",
    "Task: list each statement the policy makes about current behaviour, then check each against the code as it is now. Skip sentences worded as rules for new changes. Work through these in order:",
    "",
    "1. Secrets: the source the policy states (SOPS, sealed or external secrets, Actions secrets, environment) matches the code and config, and no plaintext credential, token or key is committed. Report a committed secret by file, line and kind only; never quote its value.",
    `2. Exposure and authentication: read the ingress, middleware and NetworkPolicy files the policy names over the Forgejo API with the read-only token in your environment, never by guessing: ${fetchBase} (use \`contents/DIR\` to list a directory). Check what is exposed and how it authenticates against what the policy says. Report a finding in such a repo with its \`repo\` field set.`,
    "3. Supply chain: Dockerfile base images, flake inputs and other pins are pinned as the policy claims, and the Renovate config covers every package manager the policy says it does.",
    "4. Lockfiles: each lockfile the policy claims is committed, and CI installs from it (`npm ci`, `--frozen-lockfile`, `--locked`).",
    "5. Scan gate and `.vex/`: the image scan runs on the pushed image in the same job before the push, blocks on fixable High and Critical findings, and each VEX statement names a product the repo still builds.",
    "",
    "Do not report what the daily rules already catch: an image push with no earlier scan line in the same workflow file, any push when the policy says there is no image, a `uses:` not pinned to a 40-hex SHA, or an invalid `.vex/*.json`. Do not report anything under Known gaps, style, or suggestions. Report only concrete mismatches between a claim the policy states and the code, each with the file and 1-based line that shows it. When nothing is wrong, report no findings.",
    "",
    "End your reply with exactly one JSON object, in a ```json fence, of this shape (omit `repo` for a file in this repo):",
    "",
    "```json",
    '{"findings":[{"file":".forgejo/workflows/ci.yml","line":42,"claim":"CI installs from the committed lockfile","evidence":"the build job runs npm install"},{"repo":"St-John-Software/fleet-infra","file":"apps/example/ingress.yaml","claim":"the ingress requires authentication","evidence":"it has no auth middleware"}]}',
    "```",
    "",
    '`claim` is the policy statement, `evidence` is what the code shows. Use `{"findings":[]}` when there are none.',
  ].join("\n");
}

/** The security contract's audit spec, registered in `CONTRACT_AUDITS`. */
export const SECURITY_AUDIT: ContractAuditSpec = {
  contract: "security",
  scannerJob: "security-contract-scanner",
  firstAuditOffsetDays: 2,
  readPolicy(repoDir) {
    const policy = readSecurityPolicy(repoDir);
    if (!policy || policy.text.includes(SECURITY_PLACEHOLDER)) return null;
    return policy;
  },
  readExceptions: (repoDir) => readSecurityExceptions(repoDir).exceptions,
  buildPrompt: buildSecurityAuditPrompt,
  parseFindings: parseSecurityAuditFindings,
  followUp: {
    dedupeKey: KNOWN_GAPS_DEDUPE_KEY,
    contractDocUrl: SECURITY_CONTRACT_DOC_URL,
  },
};
