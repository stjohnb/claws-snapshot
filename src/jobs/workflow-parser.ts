import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

/** Label prefixes that identify a GitHub-hosted (billed) runner image rather than a self-hosted
 *  one. Single source of truth — consumed by ubuntu-latest-scanner (raw `runs-on:` text),
 *  cache-on-self-hosted-scanner (parsed `runs-on`) and dynamic-workflow-runner-scanner (live
 *  API job labels). Add a new GitHub-hosted OS family here and all three pick it up. */
export const GITHUB_HOSTED_LABEL_PREFIXES = ["ubuntu-", "windows-", "macos-"];

/** True when `label` is a GitHub-hosted runner label (e.g. `ubuntu-latest`, `macos-14`).
 *  Prefix-matched with the trailing hyphen, so a bare `ubuntu`/`linux` label — which in this
 *  org is a self-hosted OS label — does NOT match. */
export function isGitHubHostedLabel(label: string): boolean {
  return GITHUB_HOSTED_LABEL_PREFIXES.some((p) => label.startsWith(p));
}

/** Comment marker that exempts one workflow FILE from the GitHub-hosted-runner rule
 *  (#2845). Owner-approved escape hatch for a workflow whose whole purpose requires
 *  GitHub's infrastructure — e.g. nixos-config's hetzner-runner-up/down.yml, which
 *  provision an on-demand runner exactly while the self-hosted pool is down. */
export const HOSTED_RUNNER_EXEMPTION_MARKER = "claws-allow-github-hosted-runner:";

/** The reason text from a `# claws-allow-github-hosted-runner: <reason>` comment line,
 *  or null when the file carries no such line. The reason is mandatory: a marker with an
 *  empty reason is not an exemption and is ignored, so the escape hatch can never be used
 *  silently. */
export function hostedRunnerExemptionReason(content: string): string | null {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimStart();
    if (!line.startsWith("#")) continue;
    const stripped = line.replace(/^#+\s*/, "");
    if (!stripped.startsWith(HOSTED_RUNNER_EXEMPTION_MARKER)) continue;
    const reason = stripped.slice(HOSTED_RUNNER_EXEMPTION_MARKER.length).trim();
    if (reason !== "") return reason;
  }
  return null;
}

export interface PushConfig {
  branches: string[] | null;
  branchesIgnore: string[] | null;
  tags: string[] | null;
}

export interface ConcurrencyConfig {
  group: string | null;
  cancelInProgress: boolean;
}

export interface StepInfo {
  uses: string | null;
  with: Record<string, unknown> | null;
}

export interface JobInfo {
  name: string;
  runsOn: string | string[] | null;
  concurrency: ConcurrencyConfig | null;
  steps: StepInfo[];
}

export interface ParsedWorkflow {
  getName(): string | null;
  getTriggers(): string[];
  getPushConfig(): PushConfig | null;
  getWorkflowRunTargets(): string[] | null;
  getTopLevelConcurrency(): ConcurrencyConfig | null;
  getJobs(): JobInfo[];
}

export function parseWorkflow(yamlText: string): ParsedWorkflow {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch {
    raw = null;
  }
  const root = isRecord(raw) ? raw : {};

  return {
    getName: () => readName(root),
    getTriggers: () => readTriggers(root),
    getPushConfig: () => readPushConfig(root),
    getWorkflowRunTargets: () => readWorkflowRunTargets(root),
    getTopLevelConcurrency: () => readConcurrency(root.concurrency),
    getJobs: () => readJobs(root),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringList(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value
      .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map((v) => String(v));
  }
  return null;
}

function readName(root: Record<string, unknown>): string | null {
  const v = root.name;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

function readTriggers(root: Record<string, unknown>): string[] {
  const on = root.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((t): t is string => typeof t === "string");
  if (isRecord(on)) return Object.keys(on);
  return [];
}

function readPushConfig(root: Record<string, unknown>): PushConfig | null {
  const on = root.on;
  if (typeof on === "string") {
    return on === "push" ? { branches: null, branchesIgnore: null, tags: null } : null;
  }
  if (Array.isArray(on)) {
    return on.includes("push") ? { branches: null, branchesIgnore: null, tags: null } : null;
  }
  if (!isRecord(on) || !("push" in on)) return null;
  const push = on.push;
  if (!isRecord(push)) {
    return { branches: null, branchesIgnore: null, tags: null };
  }
  return {
    branches: asStringList(push.branches),
    branchesIgnore: asStringList(push["branches-ignore"]),
    tags: asStringList(push.tags),
  };
}

function readWorkflowRunTargets(root: Record<string, unknown>): string[] | null {
  const on = root.on;
  if (!isRecord(on)) return null;
  const wr = on.workflow_run;
  if (!isRecord(wr)) return null;
  return asStringList(wr.workflows);
}

function readConcurrency(value: unknown): ConcurrencyConfig | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return { group: value, cancelInProgress: false };
  }
  if (!isRecord(value)) return null;
  return {
    group: typeof value.group === "string" ? value.group : null,
    cancelInProgress: value["cancel-in-progress"] === true,
  };
}

function readRunsOn(value: unknown): string | string[] | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const strs = value.filter((v): v is string => typeof v === "string");
    return strs.length > 0 ? strs : null;
  }
  return null;
}

function readSteps(value: unknown): StepInfo[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((step) => ({
      uses: typeof step.uses === "string" ? step.uses : null,
      with: isRecord(step.with) ? step.with : null,
    }));
}

function readJobs(root: Record<string, unknown>): JobInfo[] {
  const jobs = root.jobs;
  if (!isRecord(jobs)) return [];
  const result: JobInfo[] = [];
  for (const [name, body] of Object.entries(jobs)) {
    const concurrency = isRecord(body) ? readConcurrency(body.concurrency) : null;
    const runsOn = isRecord(body) ? readRunsOn(body["runs-on"]) : null;
    const steps = isRecord(body) ? readSteps(body.steps) : [];
    result.push({ name, runsOn, concurrency, steps });
  }
  return result;
}

export function listWorkflowFiles(repoDir: string): { dir: string; files: string[] } | null {
  const dir = path.join(repoDir, ".github", "workflows");
  if (!fs.existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  return { dir, files: entries.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")) };
}

export interface ParsedWorkflowFile {
  file: string;
  filePath: string;
  content: string;
  workflow: ParsedWorkflow;
}

export function listParsedWorkflows(repoDir: string): ParsedWorkflowFile[] | null {
  const wf = listWorkflowFiles(repoDir);
  if (!wf) return null;

  const result: ParsedWorkflowFile[] = [];
  for (const file of wf.files) {
    const filePath = path.join(wf.dir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    result.push({ file, filePath, content, workflow: parseWorkflow(content) });
  }
  return result;
}
