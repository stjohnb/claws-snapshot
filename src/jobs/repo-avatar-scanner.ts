import type { Repo } from "../config.js";
import { reportError } from "../error-reporter.js";
import { closeAlertIssueIfResolved, upsertAlertIssue } from "../occurrence-tracking.js";
import { getRepoConfig, getRepoConfigState, REPO_CONFIG_PATH } from "../repo-config.js";
import { mapSettledWithConcurrency } from "../util.js";

const NAME = "repo-avatar-scanner";
const ISSUE_TITLE = "chore: choose an avatar for this repo in claws.json";
const REPO_CONCURRENCY = 4;

export { ISSUE_TITLE };

/** Constant per repo, so upsertAlertIssue never re-edits an open issue. */
export function buildBody(repo: string): string {
  return [
    `\`${repo}\` does not declare an avatar in its \`${REPO_CONFIG_PATH}\`.`,
    "",
    "The Claws dashboard shows each repo's avatar next to its name on the Board, the Issues and " +
      "PRs lists, the Backlog and the repo page, so operators watching several repos can tell " +
      "what is in play at a glance instead of reading names. Repos without one show a plain " +
      "initial.",
    "",
    "### How to fix this",
    "",
    "Choose an image for this repo — how it is produced is up to the repo — commit it on the " +
      `default branch, and point \`avatar\` in \`${REPO_CONFIG_PATH}\` at its repo-relative path:`,
    "",
    "```json",
    '{"avatar": "docs/avatar.png"}',
    "```",
    "",
    "- Allowed extensions: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`.",
    "- The path must be relative to the repo root: no leading `/`, no `..` and no URL.",
    "- A square image of at least 64px and under 1 MB works best.",
    "",
    "This issue closes itself on the next daily scan once the key is set.",
    "",
    `If this repo should not have an avatar, turn this check off via the \`${NAME}\` ` +
      "job-disable config for this repo rather than closing the issue — an open issue with the " +
      "exact title above will otherwise be re-filed on the next scan.",
  ].join("\n");
}

async function scanRepo(repo: Repo): Promise<void> {
  // Fail open: a claws.json that could not be read says nothing about the avatar.
  if (getRepoConfigState(repo.fullName) === "unknown") return;

  if (getRepoConfig(repo.fullName)?.avatar) {
    await closeAlertIssueIfResolved({
      repo: repo.fullName,
      title: ISSUE_TITLE,
      logPrefix: NAME,
      reason: "avatar declared in claws.json",
    });
    return;
  }

  await upsertAlertIssue({
    repo: repo.fullName,
    title: ISSUE_TITLE,
    body: buildBody(repo.fullName),
    labels: [],
    logPrefix: NAME,
  });
}

export async function run(repos: Repo[]): Promise<void> {
  await mapSettledWithConcurrency(repos, REPO_CONCURRENCY, async (repo) => {
    try {
      await scanRepo(repo);
    } catch (err) {
      await reportError(`${NAME}:process-repo`, repo.fullName, err, { repo: repo.fullName });
    }
  });
}
