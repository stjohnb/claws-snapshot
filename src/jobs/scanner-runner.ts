import fs from "node:fs";
import { type Repo } from "../config.js";
import * as claude from "../claude.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";

// Canonical occurrence-tracking snippet emitted by main-build-monitor-scanner
// (as the notify-failures.yml `run:` body) and recommended by
// issue-comment-spam-scanner. Single source of truth — both scanners must
// advertise the identical pattern or the spam-scanner flags repos for using
// what main-build-monitor told them to adopt. The 10-space indentation matches
// the YAML `run: |` block depth; both call sites use it as-is.
export const RECURRENCE_TRACKING_SNIPPET_LINES: readonly string[] = [
  "          # On recurrence: edit issue body to bump Occurrences/Last seen instead of commenting.",
  "          set -euo pipefail",
  "          TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  '          TITLE="Build failure: ${WORKFLOW_NAME}"',
  "          existing=$(gh issue list --repo \"$REPO\" --state open \\",
  "            --search \"\\\"${TITLE}\\\" in:title\" --json number --jq '.[0].number // empty')",
  "          if [ -n \"$existing\" ]; then",
  "            body=$(gh issue view \"$existing\" --repo \"$REPO\" --json body --jq .body)",
  "            if printf '%s' \"$body\" | grep -q '^\\*\\*First seen:\\*\\*'; then",
  "              new_body=$(printf '%s' \"$body\" | awk -v ts=\"$TS\" '",
  "                /^\\*\\*Last seen:\\*\\*/ { print \"**Last seen:** \" ts; next }",
  "                /^\\*\\*Occurrences:\\*\\* / { print \"**Occurrences:** \" ($2 + 1); next }",
  "                { print }')",
  "            else",
  "              new_body=\"${body}\"$'\\n\\n---\\n**First seen:** '\"${TS}\"$'\\n**Last seen:** '\"${TS}\"$'\\n**Occurrences:** 2'",
  "            fi",
  "            gh issue edit \"$existing\" --repo \"$REPO\" --body \"$new_body\"",
  "          else",
  "            body=$'Workflow **'\"${WORKFLOW_NAME}\"$'** failed on `main`: '\"${RUN_URL}\"$'\\n\\n---\\n**First seen:** '\"${TS}\"$'\\n**Last seen:** '\"${TS}\"$'\\n**Occurrences:** 1'",
  "            gh issue create --repo \"$REPO\" --title \"$TITLE\" --body \"$body\" --label bug",
  "          fi",
];

export interface ScannerSpec {
  name: string;
  issueTitle: string;
  searchQuery: string;
  label?: string;
  scan: (repoDir: string, repo: Repo) => { body: string; summary?: string } | null;
}

export interface ViolationTableOptions<T> {
  /** Optional prose emitted before the table, including any trailing "\n" needed
   *  to produce a blank line between the prose and the header row. */
  intro?: string;
  /** Header cell labels, e.g. ["File", "Job", "`runs-on`"]. */
  columns: string[];
  /** Violation rows to render. */
  rows: T[];
  /** Maps one row to its already-escaped cell strings (one per column). */
  cells: (row: T) => string[];
  /** Prose lines appended after a single blank-line spacer. */
  footer: string[];
}

export function renderViolationTable<T>(opts: ViolationTableOptions<T>): string {
  const lines: string[] = [];
  if (opts.intro !== undefined) lines.push(opts.intro);
  lines.push(`| ${opts.columns.join(" | ")} |`);
  lines.push(`|${opts.columns.map(() => "---").join("|")}|`);
  for (const row of opts.rows) {
    lines.push(`| ${opts.cells(row).join(" | ")} |`);
  }
  lines.push("", ...opts.footer);
  return lines.join("\n");
}

async function processRepo(spec: ScannerSpec, repo: Repo): Promise<void> {
  const repoDir = claude.repoDir(repo);
  if (!fs.existsSync(repoDir)) return;

  await claude.ensureClone(repo, { skipFetchIfRecent: true });

  const result = spec.scan(repoDir, repo);
  if (!result) return;

  const existing = await gh.findIssueByExactTitle(repo.fullName, spec.issueTitle);
  if (existing) {
    log.info(
      `[${spec.name}] Skipping ${repo.fullName} — open issue #${existing.number} already exists`,
    );
    return;
  }

  log.info(`[${spec.name}] ${result.summary ?? "Creating issue"} for ${repo.fullName}`);
  await gh.createIssue(repo.fullName, spec.issueTitle, result.body, spec.label ? [spec.label] : []);
}

export async function runRepoScanner(
  spec: ScannerSpec,
  repos: Repo[],
): Promise<void> {
  for (const repo of repos) {
    try {
      await processRepo(spec, repo);
    } catch (err) {
      reportError(`${spec.name}:process-repo`, repo.fullName, err);
    }
  }
}
