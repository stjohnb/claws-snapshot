# upstream-watcher

**Source**: `src/jobs/upstream-watcher.ts`
**Trigger**: Daily at 10 AM local time (`upstreamWatcherHour`, #2617)
**Targets**: `docs/upstream-watches/*.yaml` in `SELF_REPO` only (no per-repo opt-out)

Some issues can't be worked on until something lands in a repository we don't control —
an upstream PR merging, an upstream issue closing, or a new release being cut. The
established way to park such an issue is the `Blocked` label, but that means the
issue is invisible until a human happens to re-check upstream months later.

`upstream-watcher` closes that gap. Each watch file declares a parked issue and the
upstream conditions it is waiting on. Once every condition is satisfied the job removes
`Blocked` (and any legacy `Claws Ignore`), adds `Ready`, and comments on the issue with
exactly what fired — which is already the documented "re-plan this" signal, so the
normal refine/implement pipeline picks the issue up on its next pass.

The job makes no Claude calls and creates no worktrees; it is a handful of read-only
GitHub API calls a day plus, at most, three writes when a watch fires.

## File format

Watches live in `docs/upstream-watches/` in this repo. Each is a plain YAML file (no
frontmatter). `README.md` and any non-`.yaml`/`.yml` entry is ignored.

```yaml
id: seerr-oidc-stable         # optional; defaults to the filename stem
target:
  repo: St-John-Software/fleet-infra   # the parked issue's repo
  issue: 913                           # the parked issue number
require: all                  # optional; all (default) or any
conditions:                   # at least one
  - kind: pr_merged
    repo: seerr-team/seerr
    number: 2715
  - kind: release
    repo: seerr-team/seerr
    published_after: "2026-08-25"
    include_prereleases: false
note: >-                      # optional; reproduced verbatim in the unblock comment
  Anything the planner should read before starting.
```

The target issue does not have to be in this repo, and the watched repos do not have to
be ones Claws manages — external public repos are read with an installation token, which
keeps the calls off the 60 req/hr unauthenticated bucket.

### Condition kinds

| `kind` | Fields | Met when |
|--------|--------|----------|
| `pr_merged` | `repo`, `number` | The PR is **merged**. A PR closed without merging is not met, and marks the watch dead (see below). |
| `issue_closed` | `repo`, `number` | The issue is closed, however it was closed. |
| `release` | `repo`, plus the optional filters below | A release exists matching every filter. |

`release` filters:

| Field | Default | Effect |
|-------|---------|--------|
| `published_after` | none | Only releases published **strictly after** this `YYYY-MM-DD` (midnight UTC) count. Use it to require a release cut after the watch was written. |
| `tag_matches` | none | JavaScript regular expression the tag must match. A pattern that fails to compile makes the file malformed. |
| `include_prereleases` | `false` | When false, RC/beta releases are ignored. Drafts are **never** matched, either way. |

Releases are read newest-first, so the first release passing every filter is the one
reported.

## Firing

When `require: all` (default) every condition must be met; `require: any` needs one.
On a fire the job, in order:

1. removes `Blocked` and any legacy `Claws Ignore` from the target issue (a failure here is logged and does not stop the fire);
2. adds `Ready` (creating the label on the target repo if missing);
3. comments on the issue with the lead line, one bullet per condition summary, the `note`, and the path of the watch file to delete;
4. records the fire in SQLite.

Recording last means a mid-way failure just retries on the next daily run — the label
operations are idempotent.

If the conditions are not yet met the job posts **nothing**. A watch may sit for months;
a daily "still waiting" comment would be pure spam. The status is logged instead.

## Dedup

| Situation | Behaviour |
|-----------|-----------|
| Watch already fired for this `(watch id, repo, issue)` | Skipped entirely — zero GitHub calls. Re-applying `Blocked` (or the legacy `Claws Ignore`) by hand does not cause a re-fire. |
| Target issue is closed | Skipped, and **not** recorded — reopening the issue re-arms the watch. |
| Watch file deleted after firing | Nothing happens; the fire record is harmless. Deleting the file is the intended cleanup. |
| Watch file renamed (and no explicit `id`) | The `id` changes with the filename, so the watch can fire again. Set an explicit `id` if a file needs renaming. |

The dedup key is `(watch_id, repo, issue_number)` in the `upstream_watch_fires` table —
see [database-schema.md](../database-schema.md).

## Alerts

- **Dead watch.** If a watched PR was closed without merging, the watch can never fire and the issue would stay parked forever. The job raises a `Claws Ignore`-labelled `ensureAlertIssue` in `SELF_REPO` titled `[upstream-watcher] Watch "<id>" can never fire`, naming the condition and the file to edit or delete, and does not fire the watch.
- **Malformed file.** Every unparsable file in the directory is collected into a single `ensureAlertIssue` titled `[upstream-watcher] Malformed files in docs/upstream-watches/`, which includes the full schema so it can be fixed without reading the code. The alert auto-closes once every file parses.

## Security note

Upstream PR titles and release tags are third-party GitHub text, and a comment Claws
posts itself is never re-guarded when read back by `formatIssueCommentsForPrompt()`. All
such strings go through `guardContent()` before they reach the unblock comment, so a
hostile upstream PR title can't become permanently-trusted prompt-injection surface for
the planner that runs next. Release bodies are never embedded at all. The `note` field
comes from a PR-reviewed file in this repo and is therefore not guarded.

## Caveats

- The manifest is read from this repo's **default branch**, so a watch added in a PR only goes live once that PR merges.
- `published_after` is a plain date, not "after the merge". A `require: all` watch that also demands the merge is the intended way to express "a release containing this work" — the `note` should tell the planner to confirm the release actually contains it.
