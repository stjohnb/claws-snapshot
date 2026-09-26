# issue-preview-sync

**Deep dive.** Read this when you're changing how a planner's disposable
preview — a PR or a bare branch — is mirrored onto its issue or retired. The
requirement it serves is
[Keep a plan's preview evidence in step with the plan](../product/automation-lifecycle.md#keep-a-plans-preview-evidence-in-step-with-the-plan).

**Source**: `src/jobs/issue-preview-sync.ts`, over `src/issue-previews.ts`
**Trigger**: Scheduled
**Interval**: `intervals.issuePreviewSyncMs`, default 5 minutes

Some repositories let the planner show candidate output while a plan is under
review. 3d-models' `scripts/request-issue-preview.sh` force-pushes candidate
`.scad` files to `claws/preview-issue-<issue id>` and opens no PR; its CI
deploys the render to `https://www.bstjohn.net/3d-models/issue-preview/<issue
id>/<sha8>/` and writes a `preview-summary.json` there. This job keeps that
evidence visible from the issue and retires it once the plan is decided.

A repository may instead open a draft PR, labelled `Claws Ignore`, on the same
branch and post render results as a PR comment — the legacy path, still
supported for any repository that uses it — in which case this job mirrors
and retires that PR instead.

It runs on its own timer rather than inside `issue-dispatcher`, for the same
reason as [issue-shadow-sync](issue-shadow-sync.md): the dispatcher should not
gain extra writes.

## The branch contract

A preview belongs to the issue its head branch names:
`claws/preview-issue-<ref>`, where `<ref>` is a `clw_…` id (any case) or a
forge issue number. Nothing else is read — no PR-body cross-reference, no
`claws.json` key naming the issue, no table. A legacy preview PR deliberately
avoids `#<issue>` so it never appears as the issue's implementation PR, and
the native cross-reference scan (`gh.listPRsCrossReferencingIssue`) skips open
`Claws Ignore` PRs so a bare id in the preview's body does not count either. A
forge number that was imported into the native tracker resolves to the native
issue through `resolveImportedRef`. Fork PRs are ignored, and an open non-fork
PR on a preview branch always wins over the same branch read bare.

A repository with no open PR for its preview branch is read bare only when its
`claws.json` sets `issuePreviewSummaryUrl` (a `{issue}`/`{sha8}` template for
the summary JSON) and it is on GitHub — the branch listing goes through the
GitHub-only git-data `matching-refs` endpoint. A Forgejo repository that sets
the key is skipped with a warning; a repository that never sets it costs no
extra API calls.

## What it reads

Per repository, skipping any `gh.isRepoRateLimited` reports:

- `gh.listPRs(repo)` (open PRs only), filtered to preview branches, synced
  first.
- When the repo declares `issuePreviewSummaryUrl` and is on GitHub:
  `gh.listBranchesByPrefix(repo, "claws/preview-issue-")`, with any branch
  matching an open non-fork PR's head, or whose suffix does not parse as an
  issue ref, dropped.
- `gh.getIssueState` for the issue the branch names.
- The issue's comments, to find its existing `## Preview` comment.
- For a PR preview: its head SHA and conversation comments — the results are
  the newest PR comment by a bot login (`…[bot]` or `github-actions`) that is
  not a Claws comment.
- For a branch preview: `<template>` with `{issue}` (the branch suffix,
  verbatim) and `{sha8}` (the branch head's first 8 hex characters)
  substituted, fetched with a 15 second timeout. HTTP 404 means the render for
  that exact head has not landed yet — never ambiguous with a stale render,
  since the URL embeds the head. Any other non-2xx status or an unparsable
  body is reported and retried next tick.

It deliberately does not consult `gh.isDispatchSkippable` on a preview PR:
preview PRs carry `Claws Ignore` by design. An issue carrying `Backlog` or
`Claws Ignore` is left untouched.

## What it writes

One `## Preview` comment per issue and preview repository, posted as the
Planner and edited in place. For a PR preview it names the PR, branch and
head, says whether the copied results are for the current head (they contain
its first seven characters) or that the render for the current head is
pending, and copies the results comment verbatim, cut at 20,000 characters
with a link to the PR. For a branch preview it names the branch and head, says
no PR is open, links the viewer (`viewer_url` from the summary, when present),
mirrors the summary's `markdown`, and says pending when no summary exists yet
for that head — the render is still running or its build failed; check the
branch's workflow runs. The last line is the marker:

```
CLAWS_ISSUE_PREVIEW: repo=<owner/name> pr=<n>|none head=<sha> results=<12-hex sha256 of copied body | none> status=<current|retired>
```

`pr=none` marks a branch preview; the field stays backward compatible with the
legacy `pr=<n>` PR marker. Nothing is written when the marker this pass would
write equals the one already there, so a steady preview costs reads only.

## Retirement

When the issue is closed, carries `Refined` (a native issue's `approved`
lifecycle reads as `Refined`), or has an open `claws_prs` row (looked up
through `resolveTrackerId`), the job retires the preview and rewrites the
comment as a retirement record with `status=retired`:

- A PR preview is closed — firing the repository's own cleanup workflow
  (3d-models' `pr-preview-cleanup.yml` reclaims the rendered S3 prefix).
- A branch preview has its branch deleted directly — the `delete` event that
  fires the same cleanup workflow. A 404 on delete counts as done (the branch
  was already gone).

The open PR/`claws_prs` row matters because `Refined` is short-lived:
`issue-worker` removes it as soon as it opens the implementation PR, so keying
retirement on `Refined` alone risks the sync tick landing outside that window
and leaving the preview open next to an issue that has already moved to
implementation. A re-plan that opens a new PR on the same branch, or pushes a
new head, flips the comment back to `current`, because the marker's `pr=` or
`head=` differs.

The retirement record is written before the PR is closed or the branch is
deleted, so a failure there retries on the next tick without writing the
comment again; a write failure is reported and retried whole on the next tick,
before the retirement action is attempted at all.

A preview PR someone closes by hand before the plan is decided disappears from
the open listing, so the comment keeps saying `current`.

## The planner side

The planner (`issue-refiner`) looks for a preview across the issue's
repositories — an open PR first, then a bare branch — before a fresh plan or a
refinement, and when one exists adds an `## Issue preview` section to the
prompt: the PR or branch, its head, the rule to re-run the repository's
preview step only when the revised plan changes what the preview shows (and
never for prose alone, checked with a `git diff` against the preview branch),
and — for a branch preview — not to post the render summary, run the
repository's `--cleanup` step, or delete the branch itself, since Claws does
all three. Right after it posts or edits a plan it runs the same sync, so the
issue shows the preview without waiting for a tick.

## Loop guard

The `## Preview` comment is a Claws comment (`agentName: "Planner"`), so
`findUnreactedHumanComments` never treats it as feedback and it cannot trigger
another refine. It must never contain `## Implementation Plan`, which every
plan lookup keys on.

## Errors

A repository whose PR listing or branch listing fails is reported under
`issue-preview-sync:repo`; one PR's failure is reported under
`issue-preview-sync:pr`, one branch's under `issue-preview-sync:branch`, and
the rest of the repository continues.
