import { describe, it, expect } from "vitest";
import { buildJobsMatrixPage, type RepoToggleJob } from "./jobs-matrix.js";

const TOGGLES: RepoToggleJob[] = [
  { name: "scanner-dispatcher", reason: "All repo scanners" },
  { name: "doc-maintainer", reason: "Opens docs PRs" },
  { name: "idea-suggester", reason: "Posts ideas" },
  { name: "improvement-identifier", reason: "Files improvement issues" },
];
const NO_STATUS = { jobs: {}, runningTasks: [], latestRuns: new Map() };

function matrix(
  host: Record<string, string[]> = {},
  locked: Record<string, string[]> = {},
  toggles: RepoToggleJob[] = TOGGLES,
): string {
  return buildJobsMatrixPage([{ owner: "o", name: "r", fullName: "o/r" }], host, false, "dark", locked, NO_STATUS, undefined, toggles);
}

function cell(html: string, job: string): string {
  const at = html.indexOf(`name="o/r::${job}"`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<td", at), html.indexOf("</td>", at));
}

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
      jobs: { "issue-importer": false, "ci-fixer": false, "doc-maintainer": false },
      runningTasks: [],
      latestRuns: new Map(),
    };
    const html = buildJobsMatrixPage([], {}, false, "dark", {}, outOfOrderStatus);
    const ciFixerIdx = html.indexOf('class="cell-title" data-label="Job">ci-fixer</td>');
    const docMaintainerIdx = html.indexOf('class="cell-title" data-label="Job">doc-maintainer</td>');
    const issueImporterIdx = html.indexOf('class="cell-title" data-label="Job">issue-importer</td>');
    expect(ciFixerIdx).toBeGreaterThan(-1);
    expect(docMaintainerIdx).toBeGreaterThan(ciFixerIdx);
    expect(issueImporterIdx).toBeGreaterThan(docMaintainerIdx);
  });
});

describe("buildJobsMatrixPage per-repo toggle matrix", () => {
  it("renders one column per toggleable job, alphabetically, with the reason as title, plus Other", () => {
    const html = matrix();
    const names = [...html.matchAll(/<th class="job-col" title="[^"]*">([^<]+)<\/th>/g)].map((m) => m[1]);
    expect(names).toEqual(["doc-maintainer", "idea-suggester", "improvement-identifier", "scanner-dispatcher", "Other"]);
    expect(html).toContain('<th class="job-col" title="Opens docs PRs">doc-maintainer</th>');
    expect(html).not.toContain("ci-fixer");
    expect(html).not.toContain("writing-mode");
  });

  it("withholds the form when the controller has published no toggleable jobs", () => {
    const html = matrix({}, {}, []);
    expect(html).not.toContain('<form method="POST" action="/jobs">');
    expect(html).toContain("Per-repo toggles are unavailable until the background controller publishes its job list.");
  });

  it("renders an enabled job as a checked checkbox with no badge", () => {
    const c = cell(matrix(), "doc-maintainer");
    expect(c).toContain('value="true" checked');
    expect(c).not.toContain("src-badge");
  });

  it("marks a host-disabled job unchecked and editable with a host badge", () => {
    const c = cell(matrix({ "o/r": ["improvement-identifier"] }), "improvement-identifier");
    expect(c).not.toContain("checked");
    expect(c).toContain('class="src-badge src-host"');
  });

  it("renders a claws.json-locked job as a disabled checkbox with a repo badge that submits nothing", () => {
    const html = matrix({}, { "o/r": ["idea-suggester"] });
    expect(html).not.toContain('name="o/r::idea-suggester"');
    expect(html).toContain('<input type="checkbox" disabled aria-label="idea-suggester disabled by claws.json"> <span class="src-badge src-repo"');
    expect(html).toContain('name="o/r::doc-maintainer"');
  });

  it("shows a partial marker on scanner-dispatcher when a sub-scanner alias is excluded", () => {
    const c = cell(matrix({}, { "o/r": ["logging-conventions-scanner"] }), "scanner-dispatcher");
    expect(c).toContain("checked");
    expect(c).toContain('<details class="partial-marker"><summary>◐ 1 sub-scanner</summary>logging-conventions-scanner (repo)</details>');
  });

  it("keeps the partial marker when scanner-dispatcher itself is host-disabled", () => {
    const c = cell(matrix({ "o/r": ["scanner-dispatcher"] }, { "o/r": ["logging-conventions-scanner"] }), "scanner-dispatcher");
    expect(c).not.toContain("checked");
    expect(c).toContain("1 sub-scanner");
  });

  it("counts host and repo sub-scanner exclusions together", () => {
    const c = cell(matrix({ "o/r": ["ubuntu-latest-scanner"] }, { "o/r": ["migration-scanner"] }), "scanner-dispatcher");
    expect(c).toContain("migration-scanner (repo), ubuntu-latest-scanner (host)</details>");
    expect(c).toContain("◐ 2 sub-scanners");
  });

  it("lists other disabled jobs under Other with their badge, and sub-scanners only on the marker", () => {
    const html = matrix({ "o/r": ["ci-fixer"] }, { "o/r": ["triage-claws-errors", "migration-scanner"] });
    const other = html.slice(html.indexOf('<td class="other-cell">'), html.indexOf("</td>", html.indexOf('<td class="other-cell">')));
    expect(other).toContain('<code>triage-claws-errors</code> <span class="src-badge src-repo"');
    expect(other).toContain('<code>ci-fixer</code> <span class="src-badge src-host"');
    expect(other).not.toContain("migration-scanner");
  });

  it("renders a dash under Other when nothing else is disabled", () => {
    expect(matrix()).toContain('<td class="other-cell">\u2014</td>');
  });

  it("shows the repo link in short form, with the full name in a title", () => {
    const html = matrix();
    expect(html).toMatch(/<a href="\/repos\/o\/r" title="o\/r"><span class="repo-avatar"[^>]*>[^]*?<\/span>r<\/a>/);
    expect(html).not.toContain(">o/r<");
  });
});
