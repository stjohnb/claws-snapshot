// Public-repo scanner: enumerates every PUBLIC repo (archived and active) for
// the configured owners and asks Claude to scan each for accidentally-committed
// sensitive information (live secrets, private keys, credentials, PII). Findings
// are filed as an alert issue.
//
// This job deliberately does NOT go through gh.listRepos()/smart-scheduling,
// because fetchRepos() skips archived repos — and covering archived repos is the
// whole point. It manages its own enumeration and throttling instead.
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, LABELS, SELF_REPO, isJobDisabledForRepo } from "../config.js";
import * as gh from "../github.js";
import type { PublicRepoEntry } from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import * as smartSchedule from "../smart-schedule.js";
import { getModel } from "../model-selector.js";
import { classifyComplexity } from "../classify-complexity.js";
import { parseFirstValidJson } from "../json-extract.js";
import { ensureAlertIssue } from "../occurrence-tracking.js";

const NAME = "public-repo-scanner";
const ISSUE_TITLE = "Alert: potential sensitive information in public repo";

// Skip repos scanned within the last 7 days. Archived repos never change, and
// re-running Claude over every public repo daily is wasteful — weekly is plenty.
const RESCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// Bound concurrent Claude calls. On the first run nothing is in the processed
// ledger, so every public repo is due at once; batch to avoid a large fan-out.
const BATCH_SIZE = 3;

const FOOTER = "\n\n---\n*Automated public-repo scan by claws public-repo-scanner*";

export function buildPrompt(fullName: string, isArchived: boolean): string {
  return [
    `You are scanning the repository ${fullName} for accidentally-committed sensitive information.`,
    ``,
    `IMPORTANT: This repository is PUBLIC — anything committed here is world-readable.`,
    isArchived
      ? `This repository is ARCHIVED (read-only). Findings still matter: archived public repos remain world-readable.`
      : ``,
    ``,
    `Read the repository thoroughly. Report only CONCRETE, currently-committed sensitive data, such as:`,
    `- Live API keys, tokens, or secrets (not placeholders)`,
    `- Private keys (\`-----BEGIN ... PRIVATE KEY-----\`)`,
    `- Database/connection credentials or connection strings with real passwords`,
    `- \`.env\` files containing real values`,
    `- Cloud credentials (AWS access keys, GCP service-account JSON, Azure secrets)`,
    `- Plaintext passwords`,
    `- Personal data (emails, phone numbers, home addresses) that should not be public`,
    ``,
    `Rules:`,
    `- Report a finding ONLY with an exact \`path:line\` reference and the KIND of secret.`,
    `- Do NOT echo the full secret value into the finding. The alert issue is itself`,
    `  public on active repos — quote at most a short redacted prefix (e.g. "AKIA…").`,
    `- Ignore obvious placeholders/examples (\`YOUR_API_KEY\`, \`xxxx\`, \`example.com\`,`,
    `  test fixtures clearly labeled fake).`,
    `- Report findings ONLY for files committed to the repository. Before reporting,`,
    `  confirm the file is tracked by git (e.g. it appears in \`git ls-files\`). IGNORE`,
    `  untracked or git-ignored runtime artifacts such as \`.mcp-claws.json\`, local`,
    `  build output, or \`node_modules\` — these are not part of the repo.`,
    `- "No findings" is the expected and acceptable result — do NOT manufacture findings.`,
    ``,
    `Respond with ONLY a JSON block in this exact format, no other text:`,
    ``,
    "```json",
    `{`,
    `  "findings": [`,
    `    {`,
    `      "title": "Short descriptive title",`,
    `      "location": "path:line",`,
    `      "kind": "e.g. AWS access key, private key, DB password",`,
    `      "severity": "high|medium|low",`,
    `      "detail": "What it is and why it is sensitive (no full secret value)"`,
    `    }`,
    `  ]`,
    `}`,
    "```",
    ``,
    `Use an empty array if the repo is clean: \`{ "findings": [] }\`.`,
  ].join("\n");
}

const FindingSchema = z.object({
  title: z.string(),
  location: z.string(),
  kind: z.string(),
  severity: z.string(),
  detail: z.string(),
});
const ResponseSchema = z.object({ findings: z.array(z.unknown()).optional() });

export type Finding = z.infer<typeof FindingSchema>;

export function parseFindings(
  output: string,
  onFailure?: (err: unknown, candidates: string[]) => void,
): Finding[] {
  const data = parseFirstValidJson(output, ResponseSchema, NAME, onFailure);
  if (!data) return [];

  return (data.findings ?? [])
    .map((item) => FindingSchema.safeParse(item))
    .filter((r): r is z.ZodSafeParseSuccess<Finding> => r.success)
    .map((r) => r.data);
}

function buildBody(repo: PublicRepoEntry, findings: Finding[]): string {
  const header = repo.isArchived
    ? [
        `A public-repo scan of the ARCHIVED repository \`${repo.fullName}\` found potential sensitive information.`,
        ``,
        `This repository is archived (read-only), so a fix cannot be applied via PR. To remediate,`,
        `**unarchive the repo and remove/rotate the secret**, or **rotate the exposed secret** at its source.`,
      ].join("\n")
    : `A public-repo scan of \`${repo.fullName}\` found potential sensitive information. This repository is public, so anything below is world-readable — rotate any exposed secrets.`;

  // Both paths end up in public issue trackers (active repos file to the repo
  // itself; archived repos file to SELF_REPO, which is also public). Omit
  // `detail` in both cases — kind, severity, and location are enough to act on
  // without exposing contextual clues even after Claude's redaction.
  const bullets = findings
    .map((f) => `- **${f.kind}** (${f.severity}) — \`${f.location}\``)
    .join("\n");

  return `${header}\n\n${bullets}${FOOTER}`;
}

async function fileFindings(repo: PublicRepoEntry, findings: Finding[]): Promise<void> {
  const body = buildBody(repo, findings);
  if (repo.isArchived) {
    // GitHub rejects issue creation on archived repos (read-only), so route the
    // alert to SELF_REPO with a repo-specific title so each archived repo gets
    // its own tracking issue.
    await ensureAlertIssue({
      repo: SELF_REPO,
      title: `Alert: sensitive information in archived public repo ${repo.fullName}`,
      body,
      labels: [LABELS.priority],
      logPrefix: NAME,
    });
  } else {
    await ensureAlertIssue({
      repo: repo.fullName,
      title: ISSUE_TITLE,
      body,
      labels: [LABELS.priority],
      logPrefix: NAME,
    });
  }
}

export async function processRepo(repo: PublicRepoEntry): Promise<void> {
  try {
    await processRepoInner(repo);
  } catch (err) {
    reportError("public-repo-scanner:process-repo", repo.fullName, err);
  } finally {
    db.markRepoProcessedDaily(NAME, repo.fullName, smartSchedule.localDateString());
  }
}

async function processRepoInner(repo: PublicRepoEntry): Promise<void> {
  const fullName = repo.fullName;

  await claude.ensureClone(repo, { skipFetchIfRecent: true });
  const repoDir = path.join(WORK_DIR, "repos", repo.owner, repo.name);
  if (!fs.existsSync(repoDir)) return;

  const analysisBranch = `claws/secscan-${claude.randomSuffix()}`;
  const findings = await db.withTaskRecording(NAME, fullName, 0, null, async (taskId) => {
    return await claude.withNewWorktree(repo, analysisBranch, NAME, async (wt) => {
      db.updateTaskWorktree(taskId, wt, analysisBranch);

      log.info(`[${NAME}] Scanning ${fullName}${repo.isArchived ? " (archived)" : ""}`);
      const prompt = buildPrompt(fullName, repo.isArchived);
      const tier = await classifyComplexity(
        `Scanning public repository ${fullName} for accidentally-committed sensitive information.`,
        wt,
      );
      // Pin to Claude: this is text-only, but Qwen (OpenRouter/OpenCode)
      // consistently emits malformed JSON for this kind of task.
      const model = getModel(tier, "text-only", "claude");
      db.updateTaskModel(taskId, model);
      const output = await claude.runClaude(prompt, wt, {
        capability: "text-only",
        tier,
        model,
        provider: "claude",
        agent: "plan",
        onTokensUsed: db.trackTaskTokens(taskId),
      });

      const parsed = parseFindings(output, (err, candidates) => {
        const head = candidates[0]?.slice(0, 500) ?? "(no JSON candidates)";
        reportError(
          "public-repo-scanner:parse-findings",
          `${fullName}: ${err}\n--- output head ---\n${head}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      });
      db.recordTaskComplete(taskId, { commits: 0 });
      return parsed;
    });
  });

  if (findings.length === 0) {
    log.info(`[${NAME}] No findings for ${fullName}`);
    return;
  }

  log.info(`[${NAME}] ${findings.length} finding(s) in ${fullName} — filing alert`);
  await fileFindings(repo, findings);
}

export async function run(): Promise<void> {
  const repos = await gh.listPublicReposIncludingArchived();
  const lastProcessed = db.getLastProcessedTimestampsForJob(NAME);
  const now = Date.now();
  const due = repos
    .filter((r) => {
      const last = lastProcessed.get(r.fullName);
      return last === undefined || now - last >= RESCAN_INTERVAL_MS;
    })
    .filter((r) => !isJobDisabledForRepo(NAME, r.fullName));

  log.info(`[${NAME}] ${due.length}/${repos.length} public repos due for scan`);

  for (let i = 0; i < due.length; i += BATCH_SIZE) {
    const batch = due.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map((r) => processRepo(r)));
  }
}
