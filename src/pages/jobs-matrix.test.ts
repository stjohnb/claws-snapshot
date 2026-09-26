import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_JOB_NAMES, buildJobsMatrixPage } from "./jobs-matrix.js";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

const files = walk(srcRoot);

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(srcRoot, relativePath), "utf-8");
}

describe("REPO_JOB_NAMES drift guard", () => {
  it("contains every job name gated via isJobDisabledForRepo(...)", () => {
    const found = new Set<string>();
    const gateRe = /isJobDisabledForRepo\(\s*"([^"]+)"/g;
    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      for (const m of content.matchAll(gateRe)) found.add(m[1]);
    }

    const mainTs = readFile("main.ts");
    const smartScheduledRe = /smartScheduled(?:Batch)?Job\(\s*"([^"]+)"/g;
    for (const m of mainTs.matchAll(smartScheduledRe)) found.add(m[1]);

    const scannerDispatcherTs = readFile("jobs/scanner-dispatcher.ts");
    const scannerRe = /\{\s*name:\s*"([^"]+)",\s*run:/g;
    for (const m of scannerDispatcherTs.matchAll(scannerRe)) found.add(m[1]);

    const nameConstRe = /^const NAME = "([^"]+)"/m;
    const publicRepoScannerMatch = readFile("jobs/public-repo-scanner.ts").match(nameConstRe);
    if (publicRepoScannerMatch) found.add(publicRepoScannerMatch[1]);
    const actionsStorageMonitorMatch = readFile("jobs/actions-storage-monitor.ts").match(nameConstRe);
    if (actionsStorageMonitorMatch) found.add(actionsStorageMonitorMatch[1]);

    const known = new Set<string>(REPO_JOB_NAMES);
    const missing = [...found].filter((name) => !known.has(name));
    expect(missing).toEqual([]);
  });
});

describe("buildJobsMatrixPage width tier", () => {
  it("renders the wide width tier", () => {
    const html = buildJobsMatrixPage([], {}, false, "dark");
    expect(html).toContain('data-width="wide"');
  });
});

describe("buildJobsMatrixPage job status table", () => {
  const status = {
    jobs: { "issue-worker": true, "ci-fixer": false },
    runningTasks: [{ jobName: "issue-worker", repo: "org/repo", itemNumber: 42, startedAt: "2025-01-01 00:00:00" }],
    latestRuns: new Map([
      ["ci-fixer", { runId: "run-7", status: "completed", startedAt: "2025-01-01 00:00:00", completedAt: "2025-01-01 00:01:00" }],
    ]),
    paused: new Set(["ci-fixer"]),
    scheduleInfo: new Map([["issue-worker", { intervalMs: 300000 }]]),
  };

  it("renders both sections, status table first", () => {
    const html = buildJobsMatrixPage([], {}, false, "dark", {}, status);
    const statusIdx = html.indexOf("<h2>Job status</h2>");
    const togglesIdx = html.indexOf("<h2>Per-repo toggles</h2>");
    expect(statusIdx).toBeGreaterThan(-1);
    expect(togglesIdx).toBeGreaterThan(statusIdx);
    expect(html).toContain("<title>claws — jobs</title>");
  });

  it("uses the data-cards-wide card pattern for the seven-column table", () => {
    const html = buildJobsMatrixPage([], {}, false, "dark", {}, status);
    expect(html).toContain('<table class="data-cards data-cards-wide">');
    expect(html).toContain('<td class="cell-title" data-label="Job">issue-worker</td>');
    expect(html).toContain('<th class="hide-sm">Next Run</th>');
    expect(html).toContain('<th class="hide-sm">Logs</th>');
  });

  it("renders Run and Pause/Resume buttons, the running task and the latest-run link", () => {
    const html = buildJobsMatrixPage([], {}, false, "dark", {}, status);
    expect(html).toContain("trigger('issue-worker', $event)\">Run</button>");
    expect(html).toContain('id="pause-issue-worker" @click="togglePause(\'issue-worker\', $event)">Pause</button>');
    expect(html).toContain('id="pause-ci-fixer" @click="togglePause(\'ci-fixer\', $event)">Resume</button>');
    expect(html).toContain('href="/logs/issue?repo=org%2Frepo&number=42"');
    expect(html).toContain('href="/logs/run-7"');
    expect(html).toContain('id="job-ci-fixer" class="paused">Paused</span>');
  });

  it("keeps the status class off the td so it doesn't collide with the card-label ::before", () => {
    const statusWithIdle = { ...status, jobs: { ...status.jobs, "doc-maintainer": false } };
    const html = buildJobsMatrixPage([], {}, false, "dark", {}, statusWithIdle);
    expect(html).toContain('id="job-doc-maintainer" class="idle">Idle</span>');
    expect(html).not.toMatch(/<td[^>]*class="idle"/);
    expect(html).not.toMatch(/<td[^>]*class="running"/);
    expect(html).not.toMatch(/<td[^>]*class="paused"/);
  });

  it("polls /api/status every 10s", () => {
    const html = buildJobsMatrixPage([], {}, false, "dark", {}, status);
    expect(html).toContain('x-data="jobsPage()" x-init="startPolling()"');
    expect(html).toContain("fetch('/api/status')");
    expect(html).toContain("10000");
  });

  it("reads itemShort from the polled JSON instead of recomputing '#' + itemNumber", () => {
    const html = buildJobsMatrixPage([], {}, false, "dark", {}, status);
    expect(html).toContain("task.itemShort");
    expect(html).not.toContain("'#' + task.itemNumber");
  });

  it("sorts job status rows alphabetically by job name regardless of input order", () => {
    const outOfOrderStatus = {
      jobs: { "issue-importer": false, "ci-fixer": false, "dependabot-run-monitor": false },
      runningTasks: [],
      latestRuns: new Map(),
    };
    const html = buildJobsMatrixPage([], {}, false, "dark", {}, outOfOrderStatus);
    const ciFixerIdx = html.indexOf('class="cell-title" data-label="Job">ci-fixer</td>');
    const dependabotIdx = html.indexOf('class="cell-title" data-label="Job">dependabot-run-monitor</td>');
    const issueImporterIdx = html.indexOf('class="cell-title" data-label="Job">issue-importer</td>');
    expect(ciFixerIdx).toBeGreaterThan(-1);
    expect(dependabotIdx).toBeGreaterThan(ciFixerIdx);
    expect(issueImporterIdx).toBeGreaterThan(dependabotIdx);
  });
});

describe("buildJobsMatrixPage per-repo toggle matrix column order", () => {
  it("renders job-col headers alphabetically, independent of REPO_JOB_NAMES registration order", () => {
    const html = buildJobsMatrixPage([], {}, false, "dark");
    const ciFixerIdx = html.indexOf('<th class="job-col">ci-fixer</th>');
    const issueDispatcherIdx = html.indexOf('<th class="job-col">issue-dispatcher</th>');
    expect(ciFixerIdx).toBeGreaterThan(-1);
    expect(issueDispatcherIdx).toBeGreaterThan(ciFixerIdx);
  });
});

describe("claws.json-locked cells (#2885)", () => {
  const repos = [{ owner: "o", name: "r", fullName: "o/r" }];

  it("renders a locked job as a disabled checkbox that submits nothing", () => {
    const html = buildJobsMatrixPage(repos, {}, false, "dark", { "o/r": ["doc-maintainer"] });

    expect(html).toContain('<td><input type="checkbox" disabled title="Disabled by claws.json in the repo"></td>');
    expect(html).not.toContain('name="o/r::doc-maintainer"');
    // Unlocked jobs keep their normal, submittable checkbox.
    expect(html).toContain('name="o/r::ci-fixer"');
  });

  it("renders every job normally when no jobs are locked", () => {
    const html = buildJobsMatrixPage(repos, {}, false, "dark");
    expect(html).not.toContain("disabled title=");
    expect(html).toContain('name="o/r::doc-maintainer"');
  });

  it("shows the repo link in short form, with the full name in a title", () => {
    const html = buildJobsMatrixPage(repos, {}, false, "dark");
    expect(html).toContain(`<a href="/repos/o/r" title="o/r">r</a>`);
    expect(html).not.toContain(">o/r<");
  });
});
