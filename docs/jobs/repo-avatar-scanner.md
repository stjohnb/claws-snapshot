# repo-avatar-scanner

**Deep dive.** Read this when you're changing the scanner that asks repos to
declare an avatar. For the `avatar` key itself, read
[../repo-config.md](../repo-config.md).

**Source**: `src/jobs/repo-avatar-scanner.ts`
**Trigger**: Via `scanner-dispatcher` (daily schedule)

The dashboard shows each repo's avatar beside its name so operators can tell
repos apart at a glance. This scanner files one issue in every monitored repo
whose `claws.json` does not declare a valid `avatar`; what the image is and how
the repo produces it is left to the repo.

## Detection

- Reads the cached `claws.json` from `src/repo-config.ts`, not the clone.
- Skips a repo whose config state is `unknown` (the file could not be read),
  failing open like discovery does.
- A repo with no `avatar`, an invalid one (dropped by `repo-config.ts`) or a
  file that fails to parse gets the issue. The scanner does not check that the
  image exists; a missing image shows the neutral initial on the dashboard.
- Issue title: `chore: choose an avatar for this repo in claws.json`. No
  labels — this fires across every managed repo on first rollout, and a human
  reviews the plan.
- The body is constant per repo, so `upsertAlertIssue` leaves an open issue
  untouched on later scans; matching on the title (or its filed title) means
  repeat scans never file a duplicate.

## Close on resolve

Once a repo declares a valid `avatar`, the next scan closes its open issue as
completed through `closeAlertIssueIfResolved`.

## Opting out

Disable `repo-avatar-scanner` for the repo on the `/jobs` matrix (or in its
`claws.json` `disabledJobs`) rather than closing the issue — an issue closed
while the key is still unset is re-filed on the next scan.
