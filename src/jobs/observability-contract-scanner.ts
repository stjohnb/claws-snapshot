import fs from "node:fs";
import path from "node:path";
import { type Repo } from "../config.js";
import * as claude from "../claude.js";
import * as clawsIssues from "../claws-issues.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { mapSettledWithConcurrency } from "../util.js";
import {
  ACCEPTED_GAP_PREFIX,
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
import { runRepoScanner, walkRepoTree, type ScannerSpec } from "./scanner-runner.js";

const NAME = "observability-contract-scanner";
// Frozen: this exact title is the findIssueByExactTitle dedupe key. Changing it
// orphans every open issue and files a duplicate in every non-compliant repo.
const ISSUE_TITLE = "chore: declare this repo's observability policy";
// The logging-only scanner's title; an open issue under it is retitled and rewritten in place.
const LEGACY_ISSUE_TITLES = ["chore: adopt the structured logging contract"];

// The per-repo follow-up for unaccepted Known gaps: one native issue per repo, keyed so
// daily scans rewrite it instead of re-filing.
export const KNOWN_GAPS_ISSUE_TITLE = "chore: close this repo's known observability gaps";
export const KNOWN_GAPS_DEDUPE_KEY = "observability-known-gaps";
const GAP_CONCURRENCY = 4;

const CONTRACT_DOC_URL =
  "https://git.home.bstjohn.net/St-John-Software/claws/src/branch/main/docs/observability-contract.md";

const SERVER_DEPS = ["next", "express", "hono", "fastify", "koa", "@nestjs/core"];
const LOGGER_DEPS = ["pino", "winston", "bunyan"];
const ASTRO_SERVER_ADAPTERS = ["@astrojs/node", "@astrojs/vercel", "@astrojs/cloudflare", "@astrojs/netlify"];
const NEXT_CONFIG_FILES = ["next.config.ts", "next.config.mts", "next.config.js", "next.config.mjs", "next.config.cjs"];
const NEXT_STATIC_EXPORT = /\boutput\s*:\s*['"]export['"]/;
const STATIC_SERVER_IMAGES = new Set(["nginx", "nginx-unprivileged", "caddy", "httpd"]);
const FROM_LINE = /^\s*FROM\s+(.*)$/i;
// CRA builds are static assets served from S3 or a CDN; `react-scripts start` is a dev server, not a runtime.
const STATIC_SPA_DEPS = ["react-scripts"];

const SOURCE_ROOTS = ["src", "lib", "app", "server"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const TEST_FILE = /\.(test|spec)\.|\.d\.ts$/;
const CONSOLE_CALL = /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/g;
const MAX_FILES_READ = 400;
const MAX_SAMPLE_PATHS = 5;

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: unknown;
  scripts?: Record<string, string>;
}

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

function readPackageJson(repoDir: string): PackageJson | null {
  const pkgPath = path.join(repoDir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as PackageJson;
  } catch {
    // Malformed manifest — not a scanner failure, just no package evidence.
    return null;
  }
}

function isNextStaticExport(repoDir: string): boolean {
  for (const rel of NEXT_CONFIG_FILES) {
    const abs = path.join(repoDir, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      return NEXT_STATIC_EXPORT.test(fs.readFileSync(abs, "utf-8"));
    } catch {
      return false;
    }
  }
  return false;
}

interface DockerfileStage {
  image: string;
  alias: string | null;
}

/** Line-based `FROM` parse: no backslash-continuation handling needed for stage detection. */
function parseDockerfileStages(text: string): DockerfileStage[] {
  const stages: DockerfileStage[] = [];
  for (const line of text.split("\n")) {
    const match = FROM_LINE.exec(line);
    if (!match) continue;
    const tokens = match[1]!.trim().split(/\s+/);
    let i = 0;
    while (i < tokens.length && tokens[i]!.startsWith("--")) i++;
    const image = tokens[i];
    if (!image) continue;
    const alias = tokens[i + 1]?.toUpperCase() === "AS" && tokens[i + 2] ? tokens[i + 2]! : null;
    stages.push({ image, alias });
  }
  return stages;
}

/** The last `FROM` image, with stage-alias references (`FROM base AS runner`) resolved to the
 *  underlying image. Null when the Dockerfile is missing, unreadable, or has no FROM lines. */
function dockerfileFinalImage(repoDir: string): string | null {
  const dockerfilePath = path.join(repoDir, "Dockerfile");
  if (!fs.existsSync(dockerfilePath)) return null;
  let text: string;
  try {
    text = fs.readFileSync(dockerfilePath, "utf-8");
  } catch {
    return null;
  }
  const stages = parseDockerfileStages(text);
  if (stages.length === 0) return null;

  let idx = stages.length - 1;
  let image = stages[idx]!.image;
  for (;;) {
    let found = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (stages[i]!.alias !== null && stages[i]!.alias!.toLowerCase() === image.toLowerCase()) {
        found = i;
        break;
      }
    }
    if (found === -1) break;
    idx = found;
    image = stages[found]!.image;
  }
  return image;
}

function isStaticServerImage(image: string): boolean {
  const lastSegment = image.split("/").at(-1)!;
  const name = lastSegment.split("@")[0]!.split(":")[0]!;
  return STATIC_SERVER_IMAGES.has(name.toLowerCase());
}

/** What marks the repo as shipping a runnable service, for the issue body. */
function serviceSignals(repoDir: string, pkg: PackageJson | null, deps: Record<string, string>): string[] {
  const signals: string[] = [];
  if (fs.existsSync(path.join(repoDir, "Dockerfile"))) signals.push("a root `Dockerfile`");
  const serverDeps = SERVER_DEPS.filter((d) => d in deps);
  if (serverDeps.length > 0) signals.push(`server dependency ${serverDeps.map((d) => `\`${d}\``).join(", ")}`);
  if (pkg?.bin !== undefined) signals.push("a `bin` entrypoint");
  if (typeof pkg?.scripts?.["start"] === "string") signals.push("a `start` script");
  return signals;
}

function isService(repoDir: string, pkg: PackageJson | null, deps: Record<string, string>): boolean {
  const hasDockerfile = fs.existsSync(path.join(repoDir, "Dockerfile"));
  const hasServerDep = SERVER_DEPS.some((d) => d in deps);
  const hasEntrypoint = pkg?.bin !== undefined || typeof pkg?.scripts?.["start"] === "string";
  if (!hasDockerfile && !hasServerDep && !hasEntrypoint) return false;

  // Static bundle behind a static-file server (e.g. whyrr: Vite build behind nginx-unprivileged)
  // never reaches Loki, so a bare Dockerfile shouldn't mark it a service (#3308).
  if (hasDockerfile && !hasServerDep && !hasEntrypoint) {
    const finalImage = dockerfileFinalImage(repoDir);
    if (finalImage !== null && isStaticServerImage(finalImage)) return false;
  }

  // Static Astro sites ship no server: `astro` with no server adapter and no Dockerfile.
  // Next.js static exports (`output: 'export'`) ship no server either: `next start` in
  // `scripts` is scaffold noise left over from `create-next-app`, not a running process.
  // Static CRA SPAs ship no server either: `react-scripts` with no server dependency and no Dockerfile.
  const staticAstro =
    "astro" in deps && !ASTRO_SERVER_ADAPTERS.some((a) => a in deps) && !hasDockerfile;
  const staticNextExport = "next" in deps && !hasDockerfile && isNextStaticExport(repoDir);
  const staticSpa = STATIC_SPA_DEPS.some((d) => d in deps) && !hasDockerfile && !hasServerDep;
  return !staticAstro && !staticNextExport && !staticSpa;
}

/** The first accepted doc whose policy covers every contract rule, else the doc with the most
 *  complete policy (path null when no doc has one at all), plus whether any doc already satisfies
 *  the logging rules and the docs that exist but have no policy heading. */
function checkPolicyDocs(repoDir: string): {
  compliant: boolean;
  path: string | null;
  missing: readonly ObservabilityRule[];
  loggingSatisfied: boolean;
  withoutSection: string[];
} {
  let best: { path: string | null; missing: readonly ObservabilityRule[] } = { path: null, missing: OBSERVABILITY_RULES };
  let loggingSatisfied = false;
  // Rules met by some doc, so a policy split across docs (logging in
  // docs/logging.md, the rest in AGENTS.md) still counts as complete.
  const satisfied = new Set<string>();
  let placeholderDoc = false;
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
    if (missing.length === 0) return { compliant: true, path: doc.path, missing, loggingSatisfied: true, withoutSection };
    const hasSection =
      doc.wholeDocument || findObservabilitySection(text) !== null || text.includes(OBSERVABILITY_CONTRACT_MARKDOWN);
    const missingIds = new Set(missing.map((r) => r.id));
    for (const r of OBSERVABILITY_RULES) {
      if (r.failsWhenPresent) {
        if (hasSection && missingIds.has(r.id)) placeholderDoc = true;
      } else if (!missingIds.has(r.id)) satisfied.add(r.id);
    }
    if (missing.every((r) => r.area !== "logging") || missingLoggingRules(text).length === 0) loggingSatisfied = true;
    if (!doc.wholeDocument && findObservabilitySection(text) === null && !text.includes(OBSERVABILITY_CONTRACT_MARKDOWN)) {
      withoutSection.push(doc.path);
      continue;
    }
    if (best.path === null || missing.length < best.missing.length) best = { path: doc.path, missing };
  }
  if (!placeholderDoc && OBSERVABILITY_RULES.every((r) => r.failsWhenPresent || satisfied.has(r.id))) {
    return { compliant: true, path: best.path, missing: [], loggingSatisfied: true, withoutSection };
  }
  return { compliant: false, ...best, loggingSatisfied, withoutSection };
}

function countConsoleCalls(repoDir: string, evidence: ObservabilityEvidence): void {
  let filesRead = 0;
  for (const root of SOURCE_ROOTS) {
    const rootAbs = path.join(repoDir, root);
    if (!fs.existsSync(rootAbs)) continue;
    walkRepoTree(rootAbs, {
      maxDepth: 5,
      extraSkipDirs: ["__tests__", "tests", "test", "fixtures"],
      onDirectory: ({ relPath, entries }) => {
        for (const entry of entries) {
          if (filesRead >= MAX_FILES_READ) return;
          if (!entry.isFile()) continue;
          if (!SOURCE_EXTENSIONS.has(path.extname(entry.name)) || TEST_FILE.test(entry.name)) continue;
          const repoRel = relPath === "" ? `${root}/${entry.name}` : `${root}/${relPath}/${entry.name}`;
          filesRead++;
          let content: string;
          try {
            content = fs.readFileSync(path.join(repoDir, repoRel), "utf-8");
          } catch {
            continue;
          }
          const matches = content.match(CONSOLE_CALL)?.length ?? 0;
          if (matches === 0) continue;
          evidence.consoleCalls += matches;
          if (evidence.consoleSamples.length < MAX_SAMPLE_PATHS) evidence.consoleSamples.push(repoRel);
        }
      },
    });
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
    "This repo has not declared a complete observability policy under the St-John-Software observability contract: what it logs, which metrics and traces it emits, its latency budgets, where its dashboards and alerts live, and what each new route, DB query, background job or external call must add. Every managed repo declares one, or states that it emits no runtime telemetry.",
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
    `- [ ] Check every current-behaviour statement in the policy against the code, and add a \`${KNOWN_GAPS_HEADING}\` section listing each place existing code falls short of the contract or of the policy's own per-change rules (one list item each, or \`None.\`); start an accepted gap's item with \`${ACCEPTED_GAP_PREFIX} <reason>\`. For the unaccepted gaps the daily scan files one follow-up issue, \`${KNOWN_GAPS_ISSUE_TITLE}\` (dedupe key \`${KNOWN_GAPS_DEDUPE_KEY}\`).`,
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

function scan(repoDir: string): { body: string; summary?: string } | null {
  const docs = checkPolicyDocs(repoDir);
  if (docs.compliant) return null;

  const pkg = readPackageJson(repoDir);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
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

/** The repo's declared policy text and its path, read the way `checkPolicyDocs` reads it; null when none. */
function readPolicy(repoDir: string): { path: string; text: string } | null {
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

function formatKnownGapsBody(policyPath: string, gaps: readonly KnownGap[]): string {
  return [
    `\`${policyPath}\` lists ${gaps.length} known observability gap(s) under \`${KNOWN_GAPS_HEADING}\` that are not marked accepted: places where this repo's existing code falls short of the St-John-Software observability contract or of the policy's own per-change rules.`,
    "",
    "**Unaccepted gaps:**",
    "",
    ...gaps.map((g) => `- ${g.text}`),
    "",
    "**Asks:**",
    "",
    "- [ ] Close each gap by instrumenting the code, then remove it from the policy's Known gaps list (or write `None.` once the list is empty).",
    `- [ ] A gap the repo decides to live with stays listed with its item starting \`${ACCEPTED_GAP_PREFIX} <reason>\` instead.`,
    "",
    `The daily \`${NAME}\` scan rewrites this body while the issue is open and never re-files it after a close as not planned. Close it as completed once no unaccepted gap remains.`,
    "",
    `Canonical contract: ${CONTRACT_DOC_URL}`,
  ].join("\n");
}

/**
 * Files, or rewrites in place, the repo's one follow-up issue for the
 * unaccepted gaps its policy lists, keyed `KNOWN_GAPS_DEDUPE_KEY`. Never
 * re-files after the newest keyed issue closed as not planned.
 */
async function fileKnownGapIssue(repo: Repo): Promise<void> {
  const repoDir = claude.repoDir(repo);
  if (!fs.existsSync(repoDir)) return;
  const policy = readPolicy(repoDir);
  if (!policy) return;
  const gaps = (parseKnownGaps(policy.text) ?? []).filter((g) => !g.accepted);
  if (gaps.length === 0) return;

  const body = formatKnownGapsBody(policy.path, gaps);
  const open = await clawsIssues.findOpenIssueByDedupeKey(repo.fullName, KNOWN_GAPS_DEDUPE_KEY);
  if (open) {
    if (open.body === body) return;
    await clawsIssues.editIssue(open.id, body);
    log.info(`[${NAME}] Updated known-gaps issue ${open.id} for ${repo.fullName} (${gaps.length} gap(s))`);
    return;
  }
  const closed = await clawsIssues.findRecentlyClosedIssueByDedupeKey(repo.fullName, KNOWN_GAPS_DEDUPE_KEY, new Date(0));
  if (closed?.state_reason === "not_planned") {
    log.info(`[${NAME}] Skipping known-gaps issue for ${repo.fullName} — ${closed.id} closed as not planned (${gaps.length} gap(s))`);
    return;
  }
  const id = await clawsIssues.createIssue({
    title: KNOWN_GAPS_ISSUE_TITLE,
    body,
    authorLogin: clawsIssues.CLAWS_NATIVE_LOGIN,
    repos: [repo.fullName],
    source: "automation",
    dedupeKey: KNOWN_GAPS_DEDUPE_KEY,
  });
  log.info(`[${NAME}] Filed known-gaps issue ${id} for ${repo.fullName} (${gaps.length} gap(s))`);
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
