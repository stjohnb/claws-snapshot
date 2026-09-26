# issue-shadow-sync

**Deep dive.** Read this when you're changing how a live forge issue's native
backing record is kept in step. For what a shadow *is* and where it is hidden,
read [issue-tracker.md § Shadows](../issue-tracker.md#shadows); for the
promotion that turns one into a live native issue, read
[issue-importer.md](issue-importer.md).

**Source**: `src/jobs/issue-shadow-sync.ts`
**Trigger**: Scheduled
**Interval**: `intervals.issueShadowSyncMs`, default 5 minutes

Every issue Claws works must have a row in `claws_issues`, whichever forge it
was filed on, so that a column or a table added to the native schema applies to
all of them (#3246). This job is what makes that true for the forge-filed ones:
once per interval, per repository, it mints a `kind = 'shadow'` row for every
open forge issue that lacks one and brings the rest back in line with the
forge.

It runs on its own timer rather than as a step inside `issue-dispatcher`
deliberately: that job is the most critical one on the fleet and should not
gain database writes.

## What it reads

Per repository, skipping any for which `gh.isRepoRateLimited` is true — the
breaker is GitHub-only, so Forgejo repositories keep syncing through it:

- `gh.listOpenIssues(repo)`, filtered to issues `gh.isNativeIssue` says are
  *not* native. A native issue is already a `claws_issues` row; only a
  forge-filed one needs a shadow standing in for it.
- `db.listShadowIssues(repo)`, which returns the repository's shadows with
  their forge numbers and labels attached, already ordered
  least-recently-checked first.
- `gh.getIssueState(repo, n)`, but only for a shadow the open listing did not
  account for, and at most `CLOSE_CHECK_CAP` (25) of those per repository per
  run.

Title, body, labels and open/closed state are synced. Body rides along on the
listing the job already reads, so it costs nothing extra. Comments and
reactions are **not** copied: a shadow is not a second operator-facing issue.

## What it never does

No forge write, anywhere in the file — no label, no comment, no close, no
edit. A shadow is a mirror, and a mirror that wrote back would be a second
automation acting on the operator's issue. That is also why a shadowed forge
issue is never marked `Claws Ignore`: the shadow is hidden from the façade's
union already, so there is nothing on the forge to keep the automation away
from.

It also emits no dashboard event, because every write goes through `db.ts`'s
shadow helpers rather than through `src/claws-issues.ts` — there is no page
listing the row an event would be about.

## The return values drive the control flow

The linkage key `(repo, forge_number)` is shared by imports and shadows and
only `kind` tells them apart, so two of the store helpers answer with more than
a boolean and the job branches on what they say rather than inspecting the
linkage row itself:

- **`db.createShadowIssue`** is called unconditionally for a forge issue with
  no local shadow record. It answers `{id, created}`, or **nothing** when the
  linkage row already there names an *imported* issue. That last case is not a
  race — it is the permanent state of every issue the repository has ever
  imported, and a human reopening one puts it back in this listing forever — so
  the job skips the issue rather than writing to a row every `updateShadowIssue`
  would refuse. A `created: false` answer means a shadow existed that this
  run's listing did not carry; it is brought in line and counted as examined.
- **`db.updateShadowIssue`** is called when the forge says something the shadow
  does not already say. The job compares first — an alert-bridge issue rewrites
  its body on every occurrence, so most cycles reach most shadows with nothing
  to do, and an unconditional call would bump `updated_at` fleet-wide every
  five minutes. It answers `changed`, `unchanged` or `not-a-shadow`; the last
  means `issue-importer` promoted the row between the listing and this write,
  so the row leaves the run's working set at once rather than waiting for the
  next listing to drop it.

## Close detection and the read cap

A shadow that is open here but absent from the open listing is *probably*
closed on the forge — but a truncated listing or a transferred issue looks
exactly the same, so nothing closes without a direct `gh.getIssueState` read
saying `CLOSED`. An `OPEN` answer leaves the shadow open. A forge reopen needs
no special handling: the issue simply reappears in the listing and the same
shadow row reopens.

Those reads are capped at 25 per repository per run, and the job logs when the
cap is hit. They are taken in the order `listShadowIssues` already provides —
ascending `claws_issues.shadow_checked_at` — so a capped run works through the
whole set across runs instead of re-reading the same few forever. This is a
safety net rather than a hot path today: the listing caps at 100 and the
largest managed repository has 17 open issues.

`db.markShadowsChecked` stamps `shadow_checked_at` for **every** shadow a run
examined, whether the look changed anything, found nothing to change, found the
row was no longer a shadow, or failed outright — a failing `getIssueState` is
caught per shadow, so one unreadable issue costs its own check rather than the
repository's whole run, and still rotates to the back of the queue instead of
holding the cap against everything behind it. That stamp is what makes the
ordering fair, and `updated_at` cannot serve in its place: a check that finds nothing changed
deliberately writes no issue column at all, so a shadow whose check never
changes anything would sit at the head of the queue on every run and starve
everything behind it.

## Failure behaviour

Errors are caught per repository and reported through `reportError` under
`issue-shadow-sync:repo`, so one repository's failed listing costs that
repository's sync for the cycle and nothing else. A missed cycle is harmless —
the next one re-reads the forge from scratch.
