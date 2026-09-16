import type { Repo } from "../config.js";
import * as gh from "../github.js";
import type { DependabotUpdateRun } from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { ensureAlertIssue, closeAlertIssueIfResolved } from "../occurrence-tracking.js";
import * as smartSchedule from "../smart-schedule.js";
import { guardContent } from "../prompt-guard.js";
import { renderViolationTable } from "./scanner-runner.js";
import { normalizeDir, parseCoverage } from "./dependabot-config-scanner.js";

const NAME = "dependabot-run-monitor";
const ISSUE_TITLE = "Alert: Dependabot update jobs are failing";
const FOOTER = "\n\n---\n*Automated by claws dependabot-run-monitor*";
const MAX_RUN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Each job log is ~100 KB; cap how many we pull per repo per pass.
const MAX_LOG_FETCHES = 3;
const MAX_ERRORS_PER_GROUP = 5;
const MAX_ERROR_CHARS = 500;

const GROUP_SEPARATOR = " - Update #";

const DEPENDABOT_CONFIG_PATHS = [".github/dependabot.yml", ".github/dependabot.yaml"];
const GROUP_KEY_RE = /^(\S+)\s+in\s+(.+)$/;
const GLOB_CHARS = /[*?[\]]/;

/** Runner/infrastructure aborts. The updater never reached a verdict on the manifest, so there
 *  is nothing in the repo to fix and the next scheduled run retries on its own. GitHub records
 *  these with conclusion "failure", not "cancelled", so the conclusion filter in
 *  processRepoInner cannot separate them (#2571). */
const INFRA_ABORT_PATTERNS: RegExp[] = [
  /The runner has received a shutdown signal/i,
  /The operation was canceled/i,
  /The job was canceled/i,
  /lost communication with the server/i,
  /Received request to deprovision/i,
  /runner .*(?:was|has been) (?:shut ?down|deprovisioned)/i,
];

/** Dependabot run names use the updater's *internal* ecosystem id, which is not always the
 *  `package-ecosystem` value written in dependabot.yml. Maps run-name token → config value(s).
 *  A token absent from this table is treated as unknown and never suppressed. */
const RUN_ECOSYSTEM_ALIASES: Record<string, string[]> = {
  npm_and_yarn: ["npm", "bun"],
  github_actions: ["github-actions"],
  go_modules: ["gomod"],
  hex: ["mix"],
  pip: ["pip", "uv"],
  uv: ["uv", "pip"],
  submodules: ["gitsubmodule"],
  dotnet_sdk: ["dotnet-sdk"],
  docker_compose: ["docker-compose"],
  bundler: ["bundler"],
  cargo: ["cargo"],
  composer: ["composer"],
  devcontainers: ["devcontainers"],
  docker: ["docker"],
  elm: ["elm"],
  gradle: ["gradle"],
  helm: ["helm"],
  maven: ["maven"],
  nuget: ["nuget"],
  pub: ["pub"],
  swift: ["swift"],
  terraform: ["terraform"],
};

export type DependabotCoverage = Map<string, { dirs: Set<string>; glob: boolean }>;

const REMEDIATION_GUIDANCE = `## Remediation guidance

These failures do **not** affect CI or deploys. They mean dependency updates for the affected ecosystems have silently stopped arriving — nothing will surface them except this issue.

1. Check \`.github/dependabot.yml\` — an over-broad \`ignore\` rule or a stale \`directory\`/\`package-ecosystem\` entry can make the updater unable to resolve the manifest.
2. For npm \`EOVERRIDE\` / \`dependency_file_not_resolvable\`: a package listed in **both** \`package.json\` \`overrides\` **and** \`dependencies\`/\`devDependencies\` blocks Dependabot from bumping it, because the override pins a version the direct dependency contradicts. Remove the redundant \`overrides\` entry (or the direct dependency) so exactly one of them declares the version.
3. Reproduce locally with the exact \`npm install\` command quoted in the job log, then re-run the updater from the repository's Insights → Dependency graph → Dependabot tab.`;

export interface FailingGroup {
  key: string;
  runId: number;
  htmlUrl: string;
  createdAt: string;
  errors: string[];
}

/** "npm_and_yarn in /. - Update #1469069355" → "npm_and_yarn in /." */
export function groupKey(runName: string): string {
  const idx = runName.indexOf(GROUP_SEPARATOR);
  return (idx === -1 ? runName : runName.slice(0, idx)).trim();
}

/** Pulls the most informative error lines out of a Dependabot updater job log. */
export function extractDependabotErrors(logText: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const trimmed = s.trim();
    if (trimmed) out.push(trimmed.slice(0, MAX_ERROR_CHARS));
  };

  for (const rawLine of logText.split("\n")) {
    const line = rawLine
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "")
      .replace(/\x1b\[[0-9;]*m/g, "");

    // Richest form: names the dependency, the error type, and the detail message.
    const handled = /Handled error whilst updating (.+?): (\S+)\s*(\{.*)$/.exec(line);
    if (handled) {
      push(`${handled[1]}: ${handled[2]} ${handled[3]}`);
      continue;
    }
    const errIdx = line.indexOf("##[error]");
    if (errIdx !== -1) {
      push(line.slice(errIdx + "##[error]".length));
      continue;
    }
    const jobErr = /\bERROR <job_\d+> (.*)$/.exec(line);
    if (jobErr) push(jobErr[1]);
  }

  const deduped: string[] = [];
  for (const e of out) {
    if (!deduped.includes(e)) deduped.push(e);
    if (deduped.length === MAX_ERRORS_PER_GROUP) break;
  }
  return deduped;
}

export function buildBody(repo: string, failing: FailingGroup[]): string {
  const table = renderViolationTable({
    intro:
      `\`${repo}\`: **${failing.length}** Dependabot update job(s) are failing. ` +
      `Dependency updates for the affected ecosystems have stopped arriving.\n`,
    columns: ["Update job", "Latest run", "When"],
    rows: failing,
    cells: (g) => [`\`${g.key}\``, `[${g.runId}](${g.htmlUrl})`, g.createdAt],
    footer: [],
  });

  const sections = failing.map((g) => {
    // Job logs are third-party content that planning agents read back later.
    const body = g.errors.length
      ? g.errors
          .map((e) => guardContent(e, { repo, source: "dependabot-run-log", itemNumber: 0 }))
          .join("\n")
      : "(no error lines could be extracted from the job log — open the run link above)";
    return [`#### \`${g.key}\``, "", "```", body, "```", ""].join("\n");
  });

  return [table, ...sections, REMEDIATION_GUIDANCE, FOOTER].join("\n");
}

/** Dependabot run names spell the repo root as "/." ; dependabot.yml spells it "/". */
function normalizeRunDir(raw: string): string {
  const d = normalizeDir(raw.trim());
  return d === "/." ? "/" : d;
}

/** True when no entry in dependabot.yml can still produce this update job — GitHub keeps a
 *  retired ecosystem's last (failing) run forever, and without this the monitor re-alerts on
 *  it for 30 days. Conservative: anything ambiguous returns false so the group is reported. */
export function isRetiredGroup(key: string, coverage: DependabotCoverage): boolean {
  const m = GROUP_KEY_RE.exec(key);
  if (!m) return false; // unrecognised run-name shape
  const candidates = RUN_ECOSYSTEM_ALIASES[m[1]];
  if (!candidates) return false; // ecosystem we don't have a mapping for
  const dir = normalizeRunDir(m[2]);
  for (const eco of candidates) {
    const record = coverage.get(eco);
    if (!record) continue;
    // `directories:` (plural) or a globbed `directory:` — matching globs properly is a
    // false-positive generator, so treat the ecosystem as covered everywhere.
    if (record.glob) return false;
    for (const d of record.dirs) {
      if (GLOB_CHARS.test(d) || d === dir) return false;
    }
  }
  return true;
}

/** True when every error line extracted from the job log is an infrastructure abort.
 *  Fails open on purpose: an empty list (nothing extracted, or the group's log was never
 *  fetched because of MAX_LOG_FETCHES) returns false and is still reported, and a single real
 *  updater error alongside the cancellation lines also returns false. */
export function isInfraAbort(errors: string[]): boolean {
  return errors.length > 0 && errors.every((e) => INFRA_ABORT_PATTERNS.some((re) => re.test(e)));
}

/** Coverage declared by the repo's dependabot.yml.
 *  - empty Map  → no config file at all, so every update job is retired
 *  - null       → unreadable/unparsable, caller must fail open and report everything */
async function fetchDependabotCoverage(repo: string): Promise<DependabotCoverage | null> {
  let content: string | null = null;
  for (const p of DEPENDABOT_CONFIG_PATHS) {
    try {
      content = await gh.fetchRepoFileContent(repo, p);
    } catch (err) {
      log.warn(`[${NAME}] ${repo}: could not read ${p} (${err}) — reporting all failing jobs`);
      return null;
    }
    if (content !== null) break;
  }
  if (content === null) return new Map();
  return parseCoverage(content);
}

export async function processRepo(repo: Repo): Promise<void> {
  await smartSchedule.withDailyRepoMarking(NAME, repo.fullName, () => processRepoInner(repo));
}

async function processRepoInner(repo: Repo): Promise<void> {
  // Dependabot is a GitHub-only product; Forgejo runs no updater (#2650).
  if (repo.forge === "forgejo") return;

  try {
    const runs = await gh.listDependabotUpdateRuns(repo.fullName);
    // No updater history at all — never touch an existing issue.
    if (runs.length === 0) return;

    const cutoff = Date.now() - MAX_RUN_AGE_MS;
    const recent = runs.filter(
      (r) => r.status === "completed" && Date.parse(r.createdAt) >= cutoff,
    );
    if (recent.length === 0) return;

    // Latest run per ecosystem group is the whole self-heal mechanism: a group that has
    // since gone green must not be reported.
    const latestByGroup = new Map<string, DependabotUpdateRun>();
    for (const run of recent) {
      const key = groupKey(run.name);
      const current = latestByGroup.get(key);
      if (!current || Date.parse(run.createdAt) > Date.parse(current.createdAt)) {
        latestByGroup.set(key, run);
      }
    }

    let failing = [...latestByGroup.entries()]
      .filter(([, run]) => run.conclusion === "failure")
      .sort(([a], [b]) => a.localeCompare(b));

    // A removed `package-ecosystem` entry leaves its last failing run as the permanent "latest"
    // for that group (perudo #206: `terraform in /infra`, retired 2026-07-24, still alerting).
    if (failing.length > 0) {
      const coverage = await fetchDependabotCoverage(repo.fullName);
      if (coverage) {
        const live = failing.filter(([key]) => !isRetiredGroup(key, coverage));
        if (live.length !== failing.length) {
          const dropped = failing.filter(([key]) => isRetiredGroup(key, coverage)).map(([k]) => k);
          log.info(
            `[${NAME}] ${repo.fullName}: ignoring retired update job(s) with no matching ` +
              `.github/dependabot.yml entry: ${dropped.join(", ")}`,
          );
        }
        failing = live;
      }
    }

    const closeResolved = (reason: string) =>
      closeAlertIssueIfResolved({
        repo: repo.fullName,
        title: ISSUE_TITLE,
        logPrefix: NAME,
        reason,
      });

    if (failing.length === 0) {
      await closeResolved("Dependabot updater is green");
      return;
    }

    const groups: FailingGroup[] = [];
    for (const [key, run] of failing) {
      // Sequential and capped — each log is ~100 KB.
      const errors =
        groups.length < MAX_LOG_FETCHES
          ? extractDependabotErrors(await gh.fetchFailedJobLog(repo.fullName, run.runId))
          : [];
      groups.push({
        key,
        runId: run.runId,
        htmlUrl: run.htmlUrl,
        createdAt: run.createdAt,
        errors,
      });
    }

    const reportable = groups.filter((g) => !isInfraAbort(g.errors));
    if (reportable.length !== groups.length) {
      const dropped = groups.filter((g) => isInfraAbort(g.errors)).map((g) => g.key);
      log.info(
        `[${NAME}] ${repo.fullName}: ignoring update job(s) aborted by runner/infrastructure ` +
          `rather than a real updater error: ${dropped.join(", ")}`,
      );
    }
    if (reportable.length === 0) {
      await closeResolved("only infrastructure-aborted runs remain");
      return;
    }

    log.info(
      `[${NAME}] ${repo.fullName}: ${reportable.length} failing Dependabot update job(s) — filing/updating issue`,
    );
    await ensureAlertIssue({
      repo: repo.fullName,
      title: ISSUE_TITLE,
      body: buildBody(repo.fullName, reportable),
      // Deliberately unlabelled: a stalled updater is not an outage, and Priority-queue
      // flooding is a known problem in this repo.
      labels: [],
      logPrefix: NAME,
    });
  } catch (err) {
    reportError("dependabot-run-monitor:process-repo", repo.fullName, err);
  }
}
