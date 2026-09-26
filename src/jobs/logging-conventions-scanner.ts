import fs from "node:fs";
import path from "node:path";
import { SELF_REPO, type Repo } from "../config.js";
import { LOGGING_CONTRACT_MARKDOWN, LOGGING_DOC_PATHS, LOGGING_RULES, findLoggingSection, missingLoggingRules, type LoggingRule } from "../logging-contract.js";
import { runRepoScanner, walkRepoTree, type ScannerSpec } from "./scanner-runner.js";

const NAME = "logging-conventions-scanner";
// Frozen: this exact title is the findIssueByExactTitle dedupe key. Changing it
// orphans every open issue and files a duplicate in every non-compliant repo.
const ISSUE_TITLE = "chore: adopt the structured logging contract";

const CONTRACT_DOC_URL =
  "https://github.com/St-John-Software/claws/blob/main/docs/logging-conventions.md";

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

interface LoggingEvidence {
  loggerDeps: string[];
  /** Repo-relative path of the doc whose logging section was checked, or null when none has one. */
  loggingSectionPath: string | null;
  missingRules: readonly LoggingRule[];
  /** Logging docs that exist but have no logging heading, so a maintainer edits them rather than adding a duplicate. */
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

/** The first logging doc whose logging section covers every contract rule, else the doc with the
 *  most complete logging section (path null when no doc has a logging section at all), plus the
 *  docs that exist but have no logging heading. */
function checkLoggingDocs(repoDir: string): {
  compliant: boolean;
  path: string | null;
  missing: readonly LoggingRule[];
  withoutSection: string[];
} {
  let best: { path: string | null; missing: readonly LoggingRule[] } = { path: null, missing: LOGGING_RULES };
  const withoutSection: string[] = [];
  for (const rel of LOGGING_DOC_PATHS) {
    const abs = path.join(repoDir, rel);
    if (!fs.existsSync(abs)) continue;
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const missing = missingLoggingRules(text);
    if (missing.length === 0) return { compliant: true, path: rel, missing, withoutSection };
    if (findLoggingSection(text) === null) {
      withoutSection.push(rel);
      continue;
    }
    if (best.path === null || missing.length < best.missing.length) best = { path: rel, missing };
  }
  return { compliant: false, ...best, withoutSection };
}

function countConsoleCalls(repoDir: string, evidence: LoggingEvidence): void {
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

function formatIssueBody(evidence: LoggingEvidence): string {
  const lines: string[] = [
    "This repo ships a runnable service but has not adopted the St-John-Software structured logging contract. Every service's logs flow into Loki, and plain-text or unlevelled lines cannot be filtered by level, component or error type there.",
    "",
    "**Evidence:**",
    "",
    evidence.loggerDeps.length > 0
      ? `- Structured logger dependency present: ${evidence.loggerDeps.map((d) => `\`${d}\``).join(", ")}`
      : "- No structured logger dependency (`pino`, `winston` or `bunyan`) in `package.json`",
  ];

  if (evidence.loggingSectionPath) {
    lines.push(
      `- \`${evidence.loggingSectionPath}\` has a logging section, but it does not cover: ${evidence.missingRules.map((r) => r.label).join("; ")}`,
    );
  }
  for (const rel of evidence.docsWithoutSection) {
    lines.push(`- \`${rel}\` exists but has no logging section`);
  }
  if (!evidence.loggingSectionPath) {
    const absent = LOGGING_DOC_PATHS.filter((rel) => !evidence.docsWithoutSection.includes(rel));
    if (absent.length > 0) lines.push(`- No ${absent.map((rel) => `\`${rel}\``).join(" and no ")}`);
  }

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

  lines.push(
    "",
    "**Asks:**",
    "",
    "- [ ] Add a shared logger module wrapping pino per the reference implementation below (string `level`, ISO `time`, `service`/`component` base fields, `err` serializer).",
    "- [ ] Replace direct `console.*` calls in service code with the shared logger.",
    "- [ ] Paste the block below into `AGENTS.md` so humans and agents working here follow the contract.",
    "",
    "````markdown",
    LOGGING_CONTRACT_MARKDOWN,
    "````",
    "",
    `Canonical contract and LogQL query examples: ${CONTRACT_DOC_URL}`,
    "",
    "---",
    "",
    `If this repo intentionally does not follow the logging contract, this check can be turned off via the \`${NAME}\` job-disable config for this repo rather than by closing this issue — an open issue with the exact title above will otherwise be re-filed on the next daily scan.`,
  );

  return lines.join("\n");
}

function scan(repoDir: string, repo: Repo): { body: string; summary?: string } | null {
  // Claws' own logger conversion is tracked separately (#3272).
  if (repo.fullName === SELF_REPO) return null;

  const pkg = readPackageJson(repoDir);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (!isService(repoDir, pkg, deps)) return null;

  const docs = checkLoggingDocs(repoDir);
  if (docs.compliant) return null;

  const loggerDeps = LOGGER_DEPS.filter((d) => d in deps);
  const evidence: LoggingEvidence = {
    loggerDeps,
    loggingSectionPath: docs.path,
    missingRules: docs.missing,
    docsWithoutSection: docs.withoutSection,
    consoleCalls: 0,
    consoleSamples: [],
    frameworkDefault: frameworkDefaultLogging(deps, loggerDeps.length > 0),
  };
  countConsoleCalls(repoDir, evidence);

  return {
    body: formatIssueBody(evidence),
    summary: "service repo without the structured logging contract",
  };
}

const SPEC: ScannerSpec = {
  name: NAME,
  issueTitle: ISSUE_TITLE,
  scan,
};

export function run(repos: Repo[]): Promise<void> {
  return runRepoScanner(SPEC, repos);
}
