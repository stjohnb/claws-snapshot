import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, escapeHtml, htmlOpenTag, buildPageHeader, THEME_SCRIPT } from "./layout.js";

// IMPORTANT: Keep this list in sync with the jobs in src/main.ts (and sub-scanners
// in scanner-dispatcher.ts) that call `config.isJobDisabledForRepo(...)`. Any job
// added there with that filter must also appear here to get a UI toggle, and vice
// versa. This is enforced by src/pages/jobs-matrix.test.ts. A name whose gate is
// added here but not yet caught by that guard is not silently dropped on save —
// the POST /jobs writer in src/server.ts carries forward any out-of-list entry
// found in the existing config instead of replacing it wholesale.
export const REPO_JOB_NAMES = [
  "issue-dispatcher",
  "pr-dispatcher",
  "ci-fixer",
  "empty-pr-closer",
  "superseded-pr-closer",
  "stacked-pr-flagger",
  "doc-maintainer",
  "repo-standards",
  "improvement-identifier",
  "idea-suggester",
  "issue-auditor",
  "triage-claws-errors",
  "scanner-dispatcher",
  "stale-branch-cleaner",
  "claude-config-scanner",
  "dependabot-config-scanner",
  "ubuntu-latest-scanner",
  "concurrency-scanner",
  "migration-scanner",
  "cache-on-self-hosted-scanner",
  "issue-comment-spam-scanner",
  "runner-os-scanner",
  "design-guidelines-scanner",
  "host-policy-scanner",
  "dynamic-workflow-runner-scanner",
  "public-repo-scanner",
  "actions-storage-monitor",
  "dependabot-alert-monitor",
  "dependabot-run-monitor",
  "main-build-monitor",
  "reminder-monitor",
  "blog-draft-scanner",
  "shopping-sourcer",
  "shopping-comment-processor",
  "site-promoter",
  "dependabot-tofu-unblocker",
] as const;


export function buildJobsMatrixPage(
  repos: Array<{ owner: string; name: string; fullName: string }>,
  disabledJobsByRepo: Readonly<Record<string, readonly string[]>>,
  saved: boolean,
  theme: Theme,
): string {
  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${HEAD_META}
  <title>claws — job toggles</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
  .field-note { font-size: 0.75rem; color: var(--text-subtle); }
  .matrix-table { border-collapse: collapse; font-size: 0.85rem; }
  .matrix-table th, .matrix-table td { padding: 0.4rem 0.6rem; border: 1px solid var(--border); text-align: center; }
  .matrix-table th { position: sticky; top: 0; background: var(--bg); }
  .matrix-table td:first-child, .matrix-table th:first-child { text-align: left; position: sticky; left: 0; background: var(--bg); z-index: 1; }
  .matrix-table th:first-child { z-index: 2; }
  .matrix-wrap { overflow: auto; max-width: 100%; }
  .matrix-table th.job-col { writing-mode: vertical-lr; transform: rotate(180deg); white-space: nowrap; max-width: 2rem; }
  </style>
</head>
<body>
  ${buildPageHeader("Job Toggles", theme)}
  ${THEME_SCRIPT}
  ${saved ? '<div class="banner">Job settings saved.</div>' : ""}
  <p class="field-note">Uncheck a cell to disable a job for that repo. Changes take effect on the next scheduled run.</p>
  <form method="POST" action="/jobs">
    <div class="matrix-wrap">
      <table class="matrix-table">
        <thead>
          <tr>
            <th>Repo</th>
            ${REPO_JOB_NAMES.map(job => `<th class="job-col">${escapeHtml(job)}</th>`).join("\n            ")}
          </tr>
        </thead>
        <tbody>
          ${repos.map(repo => {
            const disabled = disabledJobsByRepo[repo.fullName] ?? [];
            return `<tr>
              <td><a href="/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}">${escapeHtml(repo.fullName)}</a></td>
              ${REPO_JOB_NAMES.map(job => {
                const checked = !disabled.includes(job);
                const fieldName = `${repo.fullName}::${job}`;
                return `<td><input type="checkbox" name="${escapeHtml(fieldName)}" value="true"${checked ? " checked" : ""}></td>`;
              }).join("\n              ")}
            </tr>`;
          }).join("\n          ")}
        </tbody>
      </table>
    </div>
    <button type="submit" class="save-btn" style="margin-top:1rem">Save</button>
  </form>
</body>
</html>`;
}
