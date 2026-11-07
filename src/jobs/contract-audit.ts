/**
 * Weekly per-repo agent audit of each registered contract (`CONTRACT_AUDITS`):
 * a read-only agent checks the changes since the last audit against the
 * policy's per-change rules and reports concrete mismatches with file and
 * line. Findings are stored per (contract, repo) in `contract_audits` and
 * picked up by the contract's daily scanner, which adds them to the repo's
 * follow-up issue. Smart-scheduled hourly; a repo is audited only when 7 days
 * have passed since its last audit and HEAD has moved since then.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import * as config from "../config.js";
import type { Repo } from "../config.js";
import * as claude from "../claude.js";
import * as db from "../db.js";
import * as log from "../log.js";
import * as smartSchedule from "../smart-schedule.js";
import { reportError } from "../error-reporter.js";
import { CONTRACT_AUDITS, type ContractAuditSpec } from "../contract-drift.js";
import { parseKnownGaps } from "../observability-contract.js";

const NAME = "contract-audit";

/** Minimum time between two audits of one repo under one contract. */
export const AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Commits a first audit (or one whose last SHA left the history) reads. */
export const FIRST_AUDIT_COMMITS = 50;

export type AuditOutcome = "audited" | "skipped-unchanged" | "skipped-not-due" | "skipped-no-policy" | "skipped-disabled" | "error";

/**
 * The local weekday (`Date.getDay()`) on which a repo with no audit record
 * gets its first audit, so the backfill is spread over the week. Only Monday
 * to Friday: the job pauses at weekends, so a weekend bucket would never run.
 */
export function firstAuditWeekday(repo: string): number {
  const n = crypto.createHash("sha256").update(repo).digest().readUInt32BE(0);
  return 1 + (n % 5);
}

/** Whether a repo last audited at `auditedAt` (null: never) is due at `now`. */
export function isAuditDue(repo: string, auditedAt: string | null, now: Date): boolean {
  if (auditedAt === null) return now.getDay() === firstAuditWeekday(repo);
  const last = Date.parse(auditedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= AUDIT_INTERVAL_MS;
}

export async function processRepo(repo: Repo): Promise<void> {
  await smartSchedule.withDailyRepoMarking(
    NAME,
    repo.fullName,
    () => processRepoInner(repo),
    (err) => {
      void reportError(`${NAME}:process-repo`, repo.fullName, err, { repo: repo.fullName });
    },
  );
}

async function processRepoInner(repo: Repo): Promise<void> {
  for (const spec of CONTRACT_AUDITS) {
    const started = Date.now();
    let outcome: AuditOutcome;
    let findings = 0;
    try {
      const result = await auditContract(repo, spec);
      outcome = result.outcome;
      findings = result.findings;
    } catch (err) {
      outcome = "error";
      await reportError(`${NAME}:process-repo`, repo.fullName, err, { repo: repo.fullName });
    }
    log.info("contract audit finished", {
      component: NAME,
      repo: repo.fullName,
      contract: spec.contract,
      outcome,
      findings,
      duration_ms: Date.now() - started,
    });
  }
}

async function auditContract(repo: Repo, spec: ContractAuditSpec): Promise<{ outcome: AuditOutcome; findings: number }> {
  if (config.isJobDisabledForRepo(spec.scannerJob, repo.fullName)) return { outcome: "skipped-disabled", findings: 0 };
  const repoDir = claude.repoDir(repo);
  if (!fs.existsSync(repoDir)) return { outcome: "skipped-no-policy", findings: 0 };
  const policy = spec.readPolicy(repoDir);
  if (!policy) return { outcome: "skipped-no-policy", findings: 0 };

  const stored = await db.getContractAudit(spec.contract, repo.fullName);
  if (!isAuditDue(repo.fullName, stored?.auditedAt ?? null, new Date())) {
    return { outcome: "skipped-not-due", findings: stored?.findings.length ?? 0 };
  }
  const head = await claude.git(["rev-parse", `origin/${repo.defaultBranch}`], repoDir);
  if (stored && stored.headSha === head) return { outcome: "skipped-unchanged", findings: stored.findings.length };

  const branch = `claws/contract-audit-${claude.randomSuffix()}`;
  const result = await db.withTaskRecording(NAME, repo.fullName, 0, null, async (taskId) => {
    return await claude.withNewWorktree(repo, branch, NAME, async (wtPath) => {
      await db.updateTaskWorktree(taskId, wtPath, branch);
      // Read the policy from the worktree so it matches the HEAD the agent audits.
      const wtPolicy = spec.readPolicy(wtPath) ?? policy;
      const auditedSha = await claude.getHeadSha(wtPath);
      const sinceSha = stored && (await isAncestor(stored.headSha, wtPath)) ? stored.headSha : null;
      const range = sinceSha ? [`${sinceSha}..HEAD`] : [`-${FIRST_AUDIT_COMMITS}`];
      const gitLog = await claude.git(["log", "--stat", ...range], wtPath);
      const gaps = parseKnownGaps(wtPolicy.text) ?? [];
      const prompt = spec.buildPrompt(wtPolicy, sinceSha, gaps, gitLog);
      const output = await claude.runClaude(prompt, wtPath, {
        tier: "sonnet",
        agent: "plan",
        onTokensUsed: db.trackTaskTokens(taskId),
      });
      const parsed = spec.parseFindings(output);
      if (parsed === null) {
        throw new Error(`${spec.contract} audit output held no valid findings JSON`);
      }
      await db.recordTaskComplete(taskId, { commits: 0 });
      return { sha: auditedSha, findings: parsed };
    });
  });

  await db.saveContractAudit(spec.contract, repo.fullName, result.sha, new Date().toISOString(), result.findings);
  return { outcome: "audited", findings: result.findings.length };
}

/** True when `sha` is an ancestor of HEAD in `wtPath`; false after a force-push or for an unknown SHA. */
async function isAncestor(sha: string, wtPath: string): Promise<boolean> {
  try {
    await claude.git(["merge-base", "--is-ancestor", sha, "HEAD"], wtPath, { maxRetries: 0 });
    return true;
  } catch {
    return false;
  }
}
