/**
 * Code evidence about a repo that both the `observability-contract-scanner`
 * and the observability drift rules read: its `package.json`, whether it ships
 * a runnable service (and the signals that say so), and where its source calls
 * `console.*` directly. Kept apart from the scanner so `observability-drift.ts`
 * can share it without importing the job.
 */
import fs from "node:fs";
import path from "node:path";
import { walkRepoTree } from "./jobs/scanner-runner.js";

export const SERVER_DEPS = ["next", "express", "hono", "fastify", "koa", "@nestjs/core"];
const ASTRO_SERVER_ADAPTERS = ["@astrojs/node", "@astrojs/vercel", "@astrojs/cloudflare", "@astrojs/netlify"];
const NEXT_CONFIG_FILES = ["next.config.ts", "next.config.mts", "next.config.js", "next.config.mjs", "next.config.cjs"];
const NEXT_STATIC_EXPORT = /\boutput\s*:\s*['"]export['"]/;
const STATIC_SERVER_IMAGES = new Set(["nginx", "nginx-unprivileged", "caddy", "httpd"]);
const FROM_LINE = /^\s*FROM\s+(.*)$/i;
// CRA builds are static assets served from S3 or a CDN; `react-scripts start` is a dev server, not a runtime.
const STATIC_SPA_DEPS = ["react-scripts"];

/** Repo-relative roots searched for service source. */
export const SOURCE_ROOTS = ["src", "lib", "app", "server"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
export const TEST_FILE = /\.(test|spec)\.|\.d\.ts$/;
const CONSOLE_CALL = /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/g;
const TEST_DIRS = ["__tests__", "tests", "test", "fixtures"];

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: unknown;
  scripts?: Record<string, string>;
}

export function readPackageJson(repoDir: string): PackageJson | null {
  const pkgPath = path.join(repoDir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as PackageJson;
  } catch {
    // Malformed manifest — not a scanner failure, just no package evidence.
    return null;
  }
}

/** Runtime and dev dependencies merged, for presence checks. */
export function packageDeps(pkg: PackageJson | null): Record<string, string> {
  return { ...pkg?.dependencies, ...pkg?.devDependencies };
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
export function dockerfileFinalImage(repoDir: string): string | null {
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

export function isStaticServerImage(image: string): boolean {
  const lastSegment = image.split("/").at(-1)!;
  const name = lastSegment.split("@")[0]!.split(":")[0]!;
  return STATIC_SERVER_IMAGES.has(name.toLowerCase());
}

/** What marks the repo as shipping a runnable service, for the issue body. */
export function serviceSignals(repoDir: string, pkg: PackageJson | null, deps: Record<string, string>): string[] {
  const signals: string[] = [];
  if (fs.existsSync(path.join(repoDir, "Dockerfile"))) signals.push("a root `Dockerfile`");
  const serverDeps = SERVER_DEPS.filter((d) => d in deps);
  if (serverDeps.length > 0) signals.push(`server dependency ${serverDeps.map((d) => `\`${d}\``).join(", ")}`);
  if (pkg?.bin !== undefined) signals.push("a `bin` entrypoint");
  if (typeof pkg?.scripts?.["start"] === "string") signals.push("a `start` script");
  return signals;
}

export function isService(repoDir: string, pkg: PackageJson | null, deps: Record<string, string>): boolean {
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

export interface ConsoleCallSite {
  /** Repo-relative, POSIX-separated path. */
  file: string;
  /** 1-based line of the file's first `console.*` call. */
  line: number;
  /** Number of `console.*` calls in the file. */
  count: number;
}

export interface FindConsoleCallsOptions {
  /** Deepest directory level read under each source root (root is 0). */
  maxDepth: number;
  /** Stop after reading this many source files. */
  maxFiles: number;
  /** Directory basenames skipped beyond the walker defaults and test dirs. */
  skipDirs?: readonly string[];
  /** Repo-relative files never reported. */
  skipFiles?: ReadonlySet<string>;
}

/**
 * Every non-test source file under `SOURCE_ROOTS` that calls `console.*`
 * directly, with its first call's line and its call count, in walk order.
 */
export function findConsoleCalls(repoDir: string, opts: FindConsoleCallsOptions): ConsoleCallSite[] {
  const sites: ConsoleCallSite[] = [];
  let filesRead = 0;
  for (const root of SOURCE_ROOTS) {
    const rootAbs = path.join(repoDir, root);
    if (!fs.existsSync(rootAbs)) continue;
    walkRepoTree(rootAbs, {
      maxDepth: opts.maxDepth,
      extraSkipDirs: [...TEST_DIRS, ...(opts.skipDirs ?? [])],
      onDirectory: ({ relPath, entries }) => {
        for (const entry of entries) {
          if (filesRead >= opts.maxFiles) return;
          if (!entry.isFile()) continue;
          if (!SOURCE_EXTENSIONS.has(path.extname(entry.name)) || TEST_FILE.test(entry.name)) continue;
          const repoRel = relPath === "" ? `${root}/${entry.name}` : `${root}/${relPath}/${entry.name}`;
          if (opts.skipFiles?.has(repoRel)) continue;
          filesRead++;
          let content: string;
          try {
            content = fs.readFileSync(path.join(repoDir, repoRel), "utf-8");
          } catch {
            continue;
          }
          const matches = [...content.matchAll(CONSOLE_CALL)];
          if (matches.length === 0) continue;
          const line = content.slice(0, matches[0]!.index).split("\n").length;
          sites.push({ file: repoRel, line, count: matches.length });
        }
      },
    });
  }
  return sites;
}
