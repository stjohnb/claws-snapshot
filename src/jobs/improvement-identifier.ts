// Unified code reviewer: analyzes codebases for security issues (files GitHub issues)
// and improvement opportunities (files GitHub issues) in a single Claude analysis call.
import { z } from "zod";
import fs from "node:fs";
import { type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import * as smartSchedule from "../smart-schedule.js";
import { formatGuardedTitleList, makeGuardCtx } from "../prompt-guard.js";
import { getModel } from "../model-selector.js";
import { classifyComplexity } from "../classify-complexity.js";
import { parseFirstValidJson, isCompleteJson } from "../json-extract.js";
import { isHomeAssistantConfigRepo } from "../home-assistant.js";

const MAX_IMPROVEMENTS_PER_RUN = 10;
const MAX_FINDINGS_PER_RUN = 5;

export function buildPrompt(fullName: string, openIssueTitles: string[], openPRTitles: string[], isPrivate: boolean): string {
  const guardCtx = makeGuardCtx(fullName, 0);
  const issueList = formatGuardedTitleList(openIssueTitles, guardCtx, "issue-title");
  const prList = formatGuardedTitleList(openPRTitles, guardCtx, "pr-title");

  return [
    `You are analyzing the repository ${fullName} for security issues and improvement opportunities.`,
    ``,
    `Read the codebase thoroughly. If \`docs/OVERVIEW.md\` exists, read it first`,
    `(and any linked documents) for context about the architecture and patterns.`,
    ``,
    `### Security findings`,
    ``,
    `Look for concrete security vulnerabilities such as:`,
    `- Injection vectors (command, SQL, prompt, HTML/XSS) in user-input paths`,
    `- Authentication/authorization gaps on sensitive routes or operations`,
    `- Hardcoded secrets, credentials, tokens, or keys committed to the repo`,
    `- Path-traversal, SSRF, unsafe deserialization`,
    `- Insecure file/permission handling (world-writable, predictable temp paths)`,
    `- Crypto misuse (weak algorithms, predictable IVs, missing authenticated encryption)`,
    `- Logging or error messages that may leak secrets/PII`,
    `- Dependencies with known CVEs (where obvious — do not invent CVEs)`,
    `- Missing input validation at trust boundaries (HTTP handlers, message queue consumers, file readers, external command builders)`,
    ``,
    `Security guidelines:`,
    `- Only report findings with a concrete exploit path. Do NOT speculate about defense-in-depth without a real risk.`,
    `- Do NOT suggest style/lint or "best practice" changes unrelated to a real risk.`,
    `- Do NOT suggest adding security headers/CSP unless the app actually serves user-facing HTML without them.`,
    `- Do NOT suggest changes requiring secret rotation, infra changes, or out-of-repo coordination — mention these in the body if relevant, but only file findings whose fix is a code change inside the repo.`,
    `- Do NOT suggest security improvements already tracked in the open issues/PRs listed below.`,
    `- "No findings" is perfectly acceptable — do not manufacture suggestions.`,
    `- Each finding should reference exact files and line numbers and describe both the vulnerability and the fix.`,
    `- Findings are visible in PRs — describe the vulnerability concretely but do not include working exploit payloads.`,
    ...(isPrivate
      ? [
          `- This repository is PRIVATE. Do NOT report threats that only apply to repositories accepting untrusted external or fork pull requests — in particular, do NOT recommend gating self-hosted GitHub Actions runners against fork PRs, restricting \`pull_request\` triggers for fork code execution, or similar fork-PR hardening. A private repository cannot receive pull requests from forks opened by users without write access, so untrusted fork code never runs on its runners. Such findings are not applicable here — skip them entirely.`,
          `- Because this repository is PRIVATE, only invited collaborators (users who already have repository access) can open issues, post comments, or open non-fork pull requests. Treat GitHub-supplied issue/comment/PR titles and bodies as authored by trusted parties, NOT as anonymous attacker input. Do NOT report findings whose only threat model is that issue/comment/PR text is attacker-controlled or a prompt-injection source (e.g. "sanitize the untrusted issue body", "an attacker could put injection text in an issue title"). This does NOT relax genuine injection findings where the untrusted input arrives from another channel (webhooks, external HTTP requests, third-party API responses, file contents, or command output) — continue to report those normally.`,
        ]
      : []),
    ``,
    `### Improvements`,
    ``,
    `Look for meaningful opportunities such as:`,
    `- Code that could be consolidated (duplicate or near-duplicate logic)`,
    `- Overcomplicated code that could be simplified`,
    `- Dead code or unused exports/dependencies`,
    `- Performance issues or inefficiencies`,
    `- Missing error handling at system boundaries`,
    `- Stale TODOs or FIXMEs that should be addressed`,
    ``,
    `Improvement guidelines:`,
    `- Be conservative. Only suggest improvements that provide clear, tangible value.`,
    `- Do NOT suggest stylistic changes, comment additions, or trivial refactors.`,
    `- Do NOT suggest adding type annotations, docstrings, or documentation.`,
    `- "No improvements found" is perfectly acceptable — do not manufacture suggestions.`,
    `- Group related improvements into a single suggestion when they should be addressed together.`,
    `- Each suggestion should be specific and actionable, referencing exact files and line numbers.`,
    ``,
    `### Web / SEO improvements (conditional)`,
    ``,
    `ONLY consider this section if the repository actually serves user-facing web pages or`,
    `generates a static site. Detect this by looking for: HTML files (\`*.html\`), a static-site`,
    `generator config (Hugo, Jekyll, Astro, Next.js, Gatsby, Eleventy/11ty, Hexo, etc.), a`,
    `\`public/\`, \`static/\`, \`_site/\`, or \`dist/\` web-output directory, or templates that emit`,
    `\`<head>\`/\`<html>\`. If the repo is a backend service, library, CLI, infra, or config repo`,
    `with NO user-facing HTML, SKIP this section entirely and report nothing for it.`,
    ``,
    `When the repo IS a website, check whether each rendered page does its best on SEO and`,
    `structured data, and suggest concrete fixes where it falls short:`,
    `- JSON-LD structured data via \`<script type="application/ld+json">\` in the page \`<head>\`,`,
    `  using appropriate schema.org types: WebSite, Person, ProfilePage, BreadcrumbList,`,
    `  BlogPosting, Blog, SoftwareApplication, CollectionPage. Start minimal (WebSite + Person`,
    `  + ProfilePage on the root/home page) rather than over-engineering.`,
    `- Node \`@id\` values using the URL-with-hash pattern (e.g. \`https://site/#person\`) so`,
    `  properties merge across pages, and \`sameAs\` linking social/external profiles.`,
    `- Standard SEO basics where missing: unique \`<title>\`, \`<meta name="description">\`,`,
    `  canonical link tags, Open Graph (\`og:*\`) and Twitter Card meta tags, \`sitemap.xml\`,`,
    `  \`robots.txt\`, descriptive \`alt\` text on images, and semantic heading structure.`,
    ``,
    `Web/SEO guidelines:`,
    `- Report these as \`improvements\` entries (same JSON shape below). There is no separate`,
    `  output field for SEO.`,
    `- Be specific: name the exact file(s) and what JSON-LD/meta block to add, with a concrete`,
    `  example snippet in the body. Do NOT file a vague "improve SEO" suggestion.`,
    `- Only suggest what is genuinely missing or substandard — if the site already has solid`,
    `  JSON-LD and meta tags, report nothing here.`,
    ``,
    `The following issues are already open in this repository — do NOT re-suggest these:`,
    issueList,
    ``,
    `The following PRs are already open in this repository — do NOT re-suggest these:`,
    prList,
    ``,
    `Respond with ONLY a JSON block in this exact format, no other text:`,
    ``,
    "```json",
    `{`,
    `  "securityFindings": [`,
    `    {`,
    `      "title": "Short descriptive title (imperative mood)",`,
    `      "body": "Detailed description with file references, the vulnerability, and the fix"`,
    `    }`,
    `  ],`,
    `  "improvements": [`,
    `    {`,
    `      "title": "Short descriptive title (imperative mood)",`,
    `      "body": "Detailed description with file references, what to change, and why"`,
    `    }`,
    `  ]`,
    `}`,
    "```",
    ``,
    `Empty arrays are acceptable for either field. Do not manufacture entries.`,
    ``,
    `If no findings or improvements are worth reporting, respond with:`,
    "```json",
    `{ "securityFindings": [], "improvements": [] }`,
    "```",
  ].join("\n");
}


const ReviewItemSchema = z.object({ title: z.string(), body: z.string() });
const ResponseSchema = z.object({
  securityFindings: z.array(z.unknown()).optional(),
  improvements: z.array(z.unknown()).optional(),
});

type ReviewItem = z.infer<typeof ReviewItemSchema>;

export function parseReviewOutput(
  output: string,
  onFailure?: (err: unknown, candidates: string[]) => void,
): { securityFindings: ReviewItem[]; improvements: ReviewItem[] } {
  const data = parseFirstValidJson(output, ResponseSchema, "improvement-identifier", onFailure);
  if (!data) return { securityFindings: [], improvements: [] };

  const securityFindings = (data.securityFindings ?? [])
    .map((item) => ReviewItemSchema.safeParse(item))
    .filter((r): r is z.ZodSafeParseSuccess<ReviewItem> => r.success)
    .map((r) => r.data);
  const improvements = (data.improvements ?? [])
    .map((item) => ReviewItemSchema.safeParse(item))
    .filter((r): r is z.ZodSafeParseSuccess<ReviewItem> => r.success)
    .map((r) => r.data);
  return { securityFindings, improvements };
}

// Kept separate for traceability in GitHub issues and PR footers
const FOOTER_SECURITY = "\n\n---\n*Automated security review by claws improvement-identifier*";
const FOOTER_IMPROVEMENT = "\n\n---\n*Automated improvement suggestion by claws improvement-identifier*";

// Dedup-checks by exact title match, creates an issue if none found. Returns true if an issue was created.
async function fileIssueIfAbsent(
  fullName: string,
  title: string,
  body: string,
  reportContext: string,
): Promise<boolean> {
  try {
    // GitHub search is substring/token-based — narrow both sides to an exact title
    // match, otherwise an unrelated open issue/PR that merely shares vocabulary
    // silently drops this finding forever (the job never revisits it). (#2118)
    const existingIssue = await gh.findIssueByExactTitle(fullName, title);
    const existingPRs = await gh.searchPRs(fullName, title);
    const exactPR = existingPRs.find((pr) => pr.title === title);
    if (existingIssue !== null || exactPR !== undefined) {
      log.info(`[improvement-identifier] Skipping "${title}" — issue or PR with this exact title already exists`);
      return false;
    }
    const issueNumber = await gh.createIssue(fullName, title, body, []);
    log.info(`[improvement-identifier] Created issue #${issueNumber} for "${title}" in ${fullName}`);
    return true;
  } catch (err) {
    reportError(reportContext, `${fullName}: ${title}`, err);
    return false;
  }
}

export async function processRepo(repo: Repo): Promise<void> {
  await smartSchedule.withDailyRepoMarking(
    "improvement-identifier",
    repo.fullName,
    () => processRepoInner(repo),
    (err) => {
      reportError("improvement-identifier:process-repo", repo.fullName, err);
    },
  );
}

async function processRepoInner(repo: Repo): Promise<void> {
  const fullName = repo.fullName;

  // Skip repos without local clones
  const repoDir = claude.repoDir(repo);
  if (!fs.existsSync(repoDir)) return;

  // Fetch open issue titles and PR titles for dedup context
  const openIssues = await gh.listOpenIssues(fullName);
  const openPRs = await gh.listPRs(fullName);

  const existingSecurityIssue = openIssues.some((i) => i.title.startsWith("security: "));
  const existingImprovementPR = openPRs.some((pr) => pr.headRefName.startsWith("claws/improve-"));

  // Both queues already full — analysis would be wasted
  if (existingSecurityIssue && existingImprovementPR) {
    log.info(`[improvement-identifier] Skipping ${fullName} — open security issue(s) and improvement PR(s) exist`);
    return;
  }

  const isPrivate = await gh.isRepoPrivate(fullName);

  const openIssueTitles = openIssues.map((i) => i.title);
  const openPRTitles = openPRs.map((p) => p.title);

  // Phase 1: Analysis — identify security findings and improvements via a single Claude call
  const analysisBranch = `claws/improve-${claude.randomSuffix()}`;
  const { securityFindings: rawFindings, improvements: rawImprovements } = await db.withTaskRecording("improvement-identifier", fullName, 0, null, async (analysisTaskId) => {
    return await claude.withNewWorktree(repo, analysisBranch, "improvement-identifier", async (analysisWt) => {
      db.updateTaskWorktree(analysisTaskId, analysisWt, analysisBranch);

      log.info(`[improvement-identifier] Analyzing ${fullName}`);
      const prompt = buildPrompt(fullName, openIssueTitles, openPRTitles, isPrivate);
      const analysisMcpConfig = claude.writeClawsMcpConfig(analysisWt, { includeHomeAssistant: isHomeAssistantConfigRepo(fullName) });
      const analysisTier = await classifyComplexity(
        `Analyzing repository ${fullName} to identify security issues and improvement opportunities.`,
        analysisWt,
      );
      // Analysis phase is text-only but stays pinned to Claude — Qwen (OpenCode/
      // OpenRouter direct) consistently emits malformed JSON for this task, which
      // blocks every downstream phase.
      const model = getModel(analysisTier, "text-only", "claude");
      db.updateTaskModel(analysisTaskId, model);
      log.info(`[improvement-identifier] Using model "${model}" for analysis of ${fullName}`);
      const output = await claude.runClaude(prompt, analysisWt, { capability: "text-only", mcpConfig: analysisMcpConfig, tier: analysisTier, model, provider: "claude", agent: "plan", onTokensUsed: db.trackTaskTokens(analysisTaskId) });

      const result = parseReviewOutput(output, (err, candidates) => {
        // A complete response contains a brace-balanced top-level JSON object. If it
        // does not, Claude's output was truncated (e.g. hit the max-tokens limit
        // mid-JSON) and returned by the CLI as a non-error partial. A trailing ``` is
        // unreliable because improvement `body` text embeds its own code fences, so a
        // truncation right after an inner fence still ends in ``` (issue #1810). Detect
        // truncation structurally instead: transient condition — warn and skip.
        const isTruncated = !isCompleteJson(output);
        if (isTruncated) {
          log.warn(
            `[improvement-identifier] Truncated/incomplete analysis output for ${fullName} — skipping parse, will retry next tick`,
          );
          return;
        }
        const head = candidates[0]?.slice(0, 500) ?? "(no JSON candidates)";
        reportError(
          "improvement-identifier:parse-findings",
          `${fullName}: ${err}\n--- output head ---\n${head}`,
          err instanceof Error ? err : new Error(String(err)),
        );
      });
      db.recordTaskComplete(analysisTaskId, { commits: 0 });
      return result;
    });
  });

  // Cap at configured limits
  const cappedFindings = rawFindings.slice(0, MAX_FINDINGS_PER_RUN);
  if (rawFindings.length > MAX_FINDINGS_PER_RUN) {
    log.info(`[improvement-identifier] Capping at ${MAX_FINDINGS_PER_RUN} security findings for ${fullName} (${rawFindings.length} identified)`);
  }
  const cappedImprovements = rawImprovements.slice(0, MAX_IMPROVEMENTS_PER_RUN);
  if (rawImprovements.length > MAX_IMPROVEMENTS_PER_RUN) {
    log.info(`[improvement-identifier] Capping at ${MAX_IMPROVEMENTS_PER_RUN} improvements for ${fullName} (${rawImprovements.length} identified)`);
  }

  // Phase 2A: File security findings (always runs first, before improvements)
  let securityFindingsFiled = 0;
  if (!existingSecurityIssue) {
    for (const finding of cappedFindings) {
      const created = await fileIssueIfAbsent(
        fullName,
        `security: ${finding.title}`,
        finding.body + FOOTER_SECURITY,
        "improvement-identifier:create-security-issue",
      );
      if (created) securityFindingsFiled++;
    }
  }

  // Phase 2B: Implement improvements (skipped on security-priority ticks)
  if (existingImprovementPR) {
    log.info(`[improvement-identifier] Skipping improvement implementation for ${fullName} — open improvement PR(s) exist`);
    return;
  }
  if (securityFindingsFiled > 0) {
    log.info(`[improvement-identifier] Security findings filed in ${fullName} — skipping improvement implementation this tick (will resume next tick)`);
    return;
  }
  if (cappedImprovements.length === 0) {
    log.info(`[improvement-identifier] No improvements identified for ${fullName}`);
    return;
  }

  for (const improvement of cappedImprovements) {
    await fileIssueIfAbsent(
      fullName,
      improvement.title,
      improvement.body + FOOTER_IMPROVEMENT,
      "improvement-identifier:create-improvement-issue",
    );
  }
}

export async function run(repos: Repo[]): Promise<void> {
  await Promise.allSettled(repos.map((repo) => processRepo(repo)));
}
