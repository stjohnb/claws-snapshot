import fs from "node:fs";
import path from "node:path";
import { type Repo } from "../config.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { mapSettledWithConcurrency } from "../util.js";
import { ACCEPTED_GAP_PREFIX, KNOWN_GAPS_HEADING, parseKnownGaps } from "../observability-contract.js";
import {
  SECURITY_CONTRACT_HEADING,
  SECURITY_CONTRACT_MARKDOWN,
  SECURITY_DOC_PATHS,
  SECURITY_GUIDANCE,
  SECURITY_PLACEHOLDER,
  SECURITY_RULES,
  detectRepoKind,
  findSecuritySection,
  missingSecurityRules,
  type RepoKind,
  type SecurityRule,
} from "../security-contract.js";
import { refreshFollowUpIssue, type ContractPolicy } from "../contract-drift.js";
import { detectSecurityDrift } from "../security-drift.js";
import { runRepoScanner, type ScannerSpec } from "./scanner-runner.js";

const NAME = "security-contract-scanner";
// Frozen: this exact title is the findIssueByExactTitle dedupe key. Changing it
// orphans every open issue and files a duplicate in every non-compliant repo.
export const ISSUE_TITLE = "chore: declare this repo's security policy";

// The per-repo follow-up for unaccepted Known gaps and drift: one native issue
// per repo, keyed so daily scans rewrite it instead of re-filing.
export const KNOWN_GAPS_ISSUE_TITLE = "chore: close this repo's known security gaps";
export const KNOWN_GAPS_DEDUPE_KEY = "security-known-gaps";

const GAP_CONCURRENCY = 4;

const CONTRACT_DOC_URL =
  "https://git.home.bstjohn.net/St-John-Software/claws/src/branch/main/docs/security-contract.md";

const KIND_LABELS: Readonly<Record<RepoKind, string>> = {
  "container-service": "container service (a Dockerfile or Containerfile)",
  infra: "infrastructure repo (Kubernetes manifests or OpenTofu)",
  "static-site": "static site (an astro, vite or next config, no Dockerfile)",
  "cli-or-library": "CLI or library",
  "firmware-or-hardware": "firmware or hardware",
  "config-only": "config-only repo",
};

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

function readDoc(repoDir: string, rel: string): string | null {
  const abs = path.join(repoDir, rel);
  if (!fs.existsSync(abs)) return null;
  try {
    return fs.readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

interface PolicyCheck {
  /** Repo-relative path of the most complete policy, or null when no doc has one. */
  path: string | null;
  missing: readonly SecurityRule[];
  /** Accepted docs that exist but have no `## Security` heading. */
  withoutSection: string[];
}

/** The first accepted doc whose policy meets every rule (missing empty), else the most complete one. */
function checkPolicyDocs(repoDir: string): PolicyCheck {
  let best: { path: string | null; missing: readonly SecurityRule[] } = { path: null, missing: SECURITY_RULES };
  const withoutSection: string[] = [];
  for (const doc of SECURITY_DOC_PATHS) {
    const text = readDoc(repoDir, doc.path);
    if (text === null) continue;
    const missing = missingSecurityRules(text, { wholeDocument: doc.wholeDocument });
    if (missing.length === 0) return { path: doc.path, missing, withoutSection };
    if (!doc.wholeDocument && findSecuritySection(text) === null) {
      withoutSection.push(doc.path);
      continue;
    }
    if (best.path === null || missing.length < best.missing.length) best = { path: doc.path, missing };
  }
  return { ...best, withoutSection };
}

function formatIssueBody(check: PolicyCheck, kind: RepoKind): string {
  const lines: string[] = [
    "This repo has not declared a complete security policy under the St-John-Software security contract: what it ships and runs, how dependency and image vulnerabilities are found, where accepted findings live, how secrets reach the code, how the supply chain is pinned, what is exposed and how it authenticates, and its Known gaps. Every managed repo declares one; a subsection that does not apply says so, with a reason.",
    "",
    "**Evidence:**",
    "",
    `- Detected repo kind: ${KIND_LABELS[kind]} (this only picks the guidance below, never whether the repo must comply)`,
  ];
  if (check.path) lines.push(`- \`${check.path}\` has a security policy, but it is incomplete`);
  for (const rel of check.withoutSection) {
    lines.push(`- \`${rel}\` exists but has no \`${SECURITY_CONTRACT_HEADING}\` section`);
  }
  if (!check.path) {
    const absent = SECURITY_DOC_PATHS.map((d) => d.path).filter((rel) => !check.withoutSection.includes(rel));
    if (absent.length > 0) lines.push(`- No ${absent.map((rel) => `\`${rel}\``).join(" and no ")}`);
  }

  lines.push("", "**Missing or incomplete subsections:**", "", ...check.missing.map((r) => `- ${r.label}`));

  lines.push("", `**Guidance for a ${KIND_LABELS[kind]}:**`, "", ...SECURITY_GUIDANCE[kind].map((g) => `- ${g}`));

  if (check.path) {
    lines.push(
      "",
      `**Check the policy against the code.** \`${check.path}\` already declares a policy, so this is not a rewrite: verify every statement it makes about current behaviour against this repo's workflows, Dockerfiles, lockfiles, \`.vex/\` statements and Renovate config, and its ingress and network policy in fleet-infra or production-infra; correct any the repo does not support, word rules for future changes as rules for new changes, and fill in the missing subsections.`,
    );
  }

  lines.push(
    "",
    "**Asks:**",
    "",
    `- [ ] Add the starter template below as \`docs/security.md\` (or as a \`${SECURITY_CONTRACT_HEADING}\` section in \`AGENTS.md\`) and replace every \`${SECURITY_PLACEHOLDER}\` line with this repo's answer, or with \`does not apply\` and the reason.`,
    `- [ ] Check every current-behaviour statement in the policy against the repo, and keep a \`${KNOWN_GAPS_HEADING}\` section listing each place existing code falls short of the contract or of the policy (one list item each, or \`None.\`); start an accepted gap's item with \`${ACCEPTED_GAP_PREFIX} <reason>\`. For the unaccepted gaps, and for any drift between the policy and the code, the daily scan files one follow-up issue, \`${KNOWN_GAPS_ISSUE_TITLE}\` (dedupe key \`${KNOWN_GAPS_DEDUPE_KEY}\`).`,
    "",
    "````markdown",
    SECURITY_CONTRACT_MARKDOWN,
    "````",
    "",
    `Canonical contract, OpenVEX format and the reference image scan gate: ${CONTRACT_DOC_URL}`,
    "",
    "---",
    "",
    `If this repo intentionally does not follow the security contract, this check can be turned off via the \`${NAME}\` job-disable config for this repo (\`disabledJobs\` in its \`claws.json\`) rather than by closing this issue — an open issue with the exact title above will otherwise be re-filed on the next daily scan.`,
  );
  return lines.join("\n");
}

/** The declare-issue body for the repo at `repoDir`, or null when its policy meets every rule. */
export function scan(repoDir: string): { body: string; summary?: string } | null {
  const check = checkPolicyDocs(repoDir);
  if (check.missing.length === 0) return null;
  return {
    body: formatIssueBody(check, detectRepoKind(repoDir)),
    summary: "repo without a complete security policy",
  };
}

const SPEC: ScannerSpec = {
  name: NAME,
  issueTitle: ISSUE_TITLE,
  scan,
};

/**
 * Files, or rewrites in place, the repo's one follow-up issue (keyed
 * `KNOWN_GAPS_DEDUPE_KEY`) for its security policy's unaccepted Known gaps
 * and the drift `detectSecurityDrift` finds between the policy and the code.
 */
async function fileKnownGapIssue(repo: Repo): Promise<void> {
  const repoDir = claude.repoDir(repo);
  if (!fs.existsSync(repoDir)) return;
  const policy = readSecurityPolicy(repoDir);
  if (!policy) return;
  const gaps = (parseKnownGaps(policy.text) ?? []).filter((g) => !g.accepted);
  const drift = detectSecurityDrift(repoDir, policy.text);
  log.info("drift check finished", { component: NAME, repo: repo.fullName, gaps: gaps.length, drift: drift.length });

  await refreshFollowUpIssue({
    job: NAME,
    repo: repo.fullName,
    title: KNOWN_GAPS_ISSUE_TITLE,
    dedupeKey: KNOWN_GAPS_DEDUPE_KEY,
    contract: "security",
    policyPath: policy.path,
    gaps,
    drift,
    audit: null,
    contractDocUrl: CONTRACT_DOC_URL,
  });
}

async function fileKnownGapIssues(repos: Repo[]): Promise<void> {
  await mapSettledWithConcurrency(repos, GAP_CONCURRENCY, async (repo) => {
    try {
      await fileKnownGapIssue(repo);
    } catch (err) {
      await reportError(`${NAME}:known-gaps`, repo.fullName, err, { repo: repo.fullName });
    }
  });
}

export async function run(repos: Repo[]): Promise<void> {
  await runRepoScanner(SPEC, repos);
  await fileKnownGapIssues(repos);
}
