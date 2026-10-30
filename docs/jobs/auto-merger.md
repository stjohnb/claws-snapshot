# auto-merger

**Deep dive.** Read this when you're changing how often open PRs are evaluated
for merge, or how a blocked merge is reported. For the merge gates themselves
(the stored merge approval, CI, infra paths), read the Merger section of
[pr-dispatcher.md](pr-dispatcher.md#merger-auto-merger).

**Source**: `src/main.ts` (job) → `sweepRepo()` in `src/agents/auto-merger.ts`
**Trigger**: Every 3 minutes (`intervals.autoMergerMs`); disabled with the `merger` agent

## Why it runs on the scheduler (#2971)

The merge sweep is pure Forgejo API: no worktree, no Claude. It used to
run only as an `auto-merger:sweep` work-queue row, which `claimNextWork`
orders behind multi-hour agent runs on a small worker pool, so an approval
could take 10–20+ minutes to act on. The job now runs inline on the scheduler,
sweeping every repo (4 at a time),
so a PR merges within about three minutes of whatever last unblocked it —
a merge approval from the dashboard, CI going green, or a conflict being resolved.

A merge approval is always a PR row's `merge_approved_by` / `merge_approved_at`.
Approving an issue through Merge (the approval track's Merge gate, or
`claws_set_issue_approval` with `through: "merge"`) writes them on every open
PR row of the issue, and the next PR Claws opens for it inherits them
(`applyIssueApproval` in `src/issue-approval-write.ts`); a single-PR approval
(`claws_approve_pr_merge`, `/prs`) writes them on one row. No label is read:
the `Automerge` label is retired (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F).

pr-dispatcher no longer enqueues a periodic sweep. The ci-fixer handler still
chains an `auto-merger:sweep` row when it finishes; pr-reviewer and
review-addresser chain one only after they reviewed, pushed or changed PR
state, never on a skip path (#clw_01M63KWT4ECG1X4VEHRS2NYHPC). That handler
calls the same `sweepRepo()`.

## Sweep behaviour

- `sweepRepo(repo)` invalidates the cached PR list, lists open PRs, skips any
  rejected by `isDispatchSkippable`, and defers any PR with a **running**
  ci-fixer, conflict fixer, review-addresser or reviewer row
  (`db.hasActiveWorkForPR`) to the next sweep. Each PR's `tryMerge` runs in its
  own try/catch, so one failure does not stop the rest.
- Every PR the sweep leaves unmerged logs a `merge_skipped` diagnostic with
  context `{repo, pr, mergeSkip}`, and every sweep ends with one
  `merge_sweep_done` line carrying `{repo, openPrCount, mergedCount,
  skippedCount}` — so a sweep that merged nothing still leaves a trace. See
  [Skip reason codes](#skip-reason-codes).
- A module-level set of repos being swept makes a second concurrent
  `sweepRepo` for the same repo return immediately, so the scheduler job and a
  chained queue row never sweep one repo at once. The scheduler's
  `runningFlags` already stops the job overlapping itself, and `mergePR` is
  pinned to the evaluated head SHA.
- In staging mode (`CLAWS_ACTIVATION_STATE=staging`) the job is part of the
  staging lane (`STAGING_PIPELINE_JOB_NAMES`); `isDispatchSkippable` still
  limits it to `Claws Staging` PRs.

## Third-party update PRs

`tryMerge` evaluates third-party update PRs (Renovate, or a
`renovate/*` branch) at any hour, like every other PR: a PR that
passes every gate merges whatever the time of day. Update tools are scheduled to
open PRs at 19:00 Europe/London instead
([pr-dispatcher.md](pr-dispatcher.md#third-party-update-prs-and-worker-protection)).
An approved PR whose review status is still `none` (not yet reviewed) is
blocked without a "Merge blocked" comment.

## No CI result on the head (`status=none`)

A head with no commit statuses or check runs reads `status=none`. That means "CI
has not reported", not "green", so it never merges on its own
(#clw_01M50MY5NZYBNSG5X0FZYXVVGS).

- **Unsettled head.** The head commit is under 5 minutes old by committer date
  (`haveChecksSettled`): the block is a quiet `checks-pending`, with the reason
  "CI has not reported on head `<sha7>` yet — waiting for it to register." and
  no "Merge blocked" comment.
- **Settled head, CI not expected.** `gh.repoExpectsCi(repo)` is false: the
  default branch has no `.yml`/`.yaml` file under `.forgejo/workflows/` or
  `.github/workflows/`, or `claws.json` sets `mergeWithoutChecks: true`
  ([repo-config.md](../repo-config.md)). `none` is accepted. The answer is
  cached per repo for 10 minutes; a listing error counts as "CI expected"
  (fail closed) and is not cached.
- **Settled head, CI expected.** The whole PR is judged, not the head commit
  alone:
  - **Case A — the whole diff is CI-exempt** (`docs/**`, `*.md`, `LICENSE`,
    `isCiExemptPath`): `none` is accepted. Doc PRs (`claws/docs-`) are
    all-docs, so this covers them. Ideas-collection PRs (`claws/ideas-collect-`)
    are accepted too.
  - **Case B — CI-exempt commits on top of a commit with a CI result:**
    `carriedForwardCheckStatus` walks the PR's commits newest-first (up to 10)
    and carries forward the status of the first commit that has any, as long as
    every commit above it changes only CI-exempt paths. This runs through
    `forgejo.carriedForwardCheckStatus`.
  - **Case C — no commit in the PR proves its code was tested:** the PR holds
    with `checks-missing`, reported on the PR like any other block of an
    approved PR, and counted on `/prs` as needing the operator.

  The `checks-missing` reason reads: "CI has not reported on head `<sha7>` — no
  commit statuses or check runs exist for it or for any earlier commit in this
  PR whose code it carries, and this repo's CI normally reports on pull
  requests. Claws will merge once CI reports green; push a new commit to start a
  run, or set `mergeWithoutChecks: true` in `claws.json` if this repo's CI never
  runs on pull requests." `claws_merge_pr` and `claws_approve_pr_merge` return
  the same reason, because they go through `attemptMerge`.

A merge approval is not a CI result: it is not accepted on `status=none` by
itself. A no-op infra plan PR is never
accepted on `none` either, since the plan run is itself a check.

### Why PR #105 merged with no CI

On 2026-10-15 claws PR #105 merged about 4 minutes after it opened, with no
statuses on head `cdce0bad`. Two things lined up:

- **No run started.** The branch arrived in one push: a `src/` commit with a
  docs-only tip on top. Forgejo evaluates `push` `paths-ignore` for a new-branch
  push against the tip commit's files only, so `ci.yml`'s
  `paths-ignore: docs/**, **/*.md, LICENSE` matched and no run was created.
  `.forgejo/workflows/ci.yml` no longer has `paths-ignore`, so every push runs CI.
- **The gate accepted the absence.** A merge approval plus a settled head was treated
  as "genuinely no CI". The settle window counts from the committer date, not
  the push time, so an agent commit made more than 5 minutes before its push
  looks settled at once.

Any other managed repo whose CI uses `push` `paths-ignore` can still hit case C
on a new-branch push. That now shows up as a visible `checks-missing` hold
rather than a silent merge.

## Workflow runs held for approval

Forgejo has no approval hold, so no reader reports `checkStatus: "held"` today.
`tryMerge` keeps a `checks-held` arm, reserved for one: it would block at info
level with a reason saying a human has to approve the runs.

## Trusted Renovate updates

A Renovate PR merges without a dashboard approval when
`isRenovateExempt` (`src/agents/auto-merger.ts`, helpers in `src/renovate.ts`)
holds — it is one of `isApprovalExempt`'s categories, alongside
`claws/docs-`, `claws/ideas-collect-` and auto-bump. A merge approval on any of these never adds a review gate (Renovate's own review gate applies approved or not):

- **Trusted author.** Not a fork, head branch `renovate/…`, and authored by the
  Forgejo `renovate` account, or by a login `gh.isAllowedHumanActor`
  accepts (fleet-infra's Renovate runs under the operator's PAT). Claws' own
  accounts, other bots and unlisted logins never qualify, and Claws'
  installation token cannot open a PR as any of these, so the #3219 threat
  model holds.
- **Not a major update.** `classifyRenovateUpdate` counts a `major-update`
  label, a title ending `(major)`, a `renovate/major-` branch, Renovate's
  `to v<N>` title shape (no dots; Renovate titles the PR with its first
  commit's subject) and a `major` row in the Update column of *any*
  `| Package | Update | Change |` table in the body (the table may sit below
  text Claws prepended). The `Update` column is read first; when no table has
  one, each row's `Change` cell is compared by leading major version (range
  prefixes such as `^ ~ == >=` and a `v` are ignored, so a 0.x minor bump is
  non-major) and any row whose major differs makes the PR major. A PR is
  classed unknown only when neither column yields a reading or a `Change` row
  cannot be parsed. With no signal at all the PR fails closed and is
  treated as major: the skip is logged as
  `skipped: not approved — update type unknown (body has no Renovate table); approve the merge from the Claws dashboard`,
  and `/prs` shows the same text as the Awaiting approval badge title, so an
  operator can tell a classification failure from a real major. Other
  not-approved PRs keep the generic wording. Claws agents never replace a
  Renovate body (see [pr-dispatcher.md](pr-dispatcher.md)), so the
  table normally survives CI fixes.

The `Automerge` label Renovate adds is never read. An exempt Renovate PR then
runs the same review gate as an approved PR — a clean Claws review whose
reviewed commit prefixes the current head, logging
`skipped: trusted Renovate update but review status=…` or
`… but clean review is stale` otherwise — followed by the infra, CI and
conflict gates every PR runs. Like every PR it is accepted on `status=none`
only under the rules in [No CI result on the head](#no-ci-result-on-the-head-statusnone).
A row with `needsHumanReview` or a recorded merge hold
(`manual_action_reason`) still blocks it.

## Auto-bump PRs

An `auto-bump` PR (an `automation/bump-*` branch) is approval-exempt only while its
diff passes the structural gate `checkAutoBumpDiff`: every changed file a YAML
manifest outside `.github/` (plus, optionally, one anchored tag append to, or one
swap of the outgoing tag for the bumped-to tag in, or removal of only the outgoing tag(s) from, a registry allowlist file:
fleet-infra's `apps/registry/config.json` or production-infra's
`infrastructure/prod/registry/config.json`),
and every manifest hunk an image-pin rewrite — the same image re-pinned to a new tag
or digest, either an `image:`/`newTag:` line or an env-var `value:` re-pin (the
Claws statefulset's `CLAWS_SESSION_IMAGE`; its tag counts for the allowlist check,
any other `value:` change fails). A same-registry bump therefore merges on green CI
with no approval and no Claws review.

`isRegistryAllowlistBump` compares allowlist entries with their trailing comma
stripped. An entry removed and re-added identical apart from its comma is a comma
fix and pairs off; what is left must be exactly one added entry for a bumped-to
tag and, for a swap, one removed entry for an outgoing tag, with the same number
of comma-terminated lines on both sides (an append may add one). With no added
entry, a pure removal is accepted when every removed entry is an outgoing tag's
(the bumped-to tag is already listed because another app pins it, production-infra
#86, #clw_01M5359MZ63V20XB4T4BC3M1W2) and each takes exactly one comma line with it. This accepts a
swap that drops an old entry from the middle of a sorted list and moves the comma
onto the previous last entry (production-infra #36,
#clw_01M4TK4C1E6VHMC09T13HDCBHJ); two net additions, any other key, or an added
entry for anything but a bumped-to tag fail.

`registryAllowlistVerdict` is the structural core: across the change, net
comma-terminated lines removed minus added must equal net entries removed minus
added, and a removed entry that is not an outgoing tag's is a stale candidate. A
candidate must be a plain anchored tag (`allowlistEntry` of it reproduces the entry
exactly), so a regex or wildcard entry fails without a scan. Only when candidates
remain does `checkAutoBumpDiff` scan the repository at the PR's head
(`pinnedTagsAtRef`: `listRepoTreePaths`, then every `*.yaml`/`*.yml` file, at most
2000, read eight at a time) and collect every pin-line tag (`newTag:`, `image:`,
env-var `value:`). A candidate any file pins fails as `non-bump-files`; a scan
error fails closed as `pin-scan-failed`, which is never cached and never commented
on the PR. This accepts production-infra #475, which dropped a stale `.3` entry
alongside the outgoing `.4` (#clw_01M64CQ46A14535D86H148D6C2). Outgoing-tag
removals, appends and swaps never scan.

A failing gate withdraws only the exemption, not the merge
(#clw_01M4RV5WKJT5XQN89BKMN7X8RH). `isApprovalExempt` reads the verdict, so the PR
takes the ordinary path:

- **With a stored merge approval** it merges like any other approved PR — a clean
  Claws review of the current head, then the infra, CI, held-run and conflict gates.
- **Without one** it is held with one of three reasons, logged at info as
  `skipped: not approved — <reason>; approve the merge from the Claws dashboard`:
  `auto-bump diff is not an image-pin-only bump` (for example a registry-host
  migration, where the image name and its `# renovate: depName=` comment change),
  `auto-bump PR touches non-bump files`,
  `auto-bump PR has no readable changed files`, or
  `auto-bump allowlist prune could not be checked against the repo's pins`. The first two are the one block
  reported on an unapproved PR: the `### Merge blocked` comment says the auto-bump
  exemption does not apply and that merging needs a merge approval (the PR's own, or its
  issue approved through Merge). The last two are log-only: `getPRChangedFiles` returns `[]` on a read
  error, the dispatcher's empty-PR closer handles genuinely empty PRs, and a failed pin
  scan is retried next sweep.

### Stalled auto-bump alert

Each sweep passes the auto-bump PRs `attemptMerge` judged to `recordSweep`
(`src/agents/auto-bump-stall.ts`), which keeps, per repo in memory, when each PR was
first held as `auto-bump-gate` with reason `non-bump-files` or `not-image-pin-only`. A PR
that merges or is refused for any other reason (an approved PR on the ordinary path,
a transient read failure) is dropped, as is one no longer open; one the sweep skipped
(dispatch guard, other work) keeps its entry. `reconcileStallAlert` then upserts the
repo's single `Auto-bump PRs held by the structural merge gate` issue, filed Blocked,
once any PR has been held for 30 minutes (`STALL_THRESHOLD_MS`), listing each held PR,
its reason and since when, and closes it once the repo has no held PR (checked once
per process and each time the held set empties). A restart restarts the clock. An
`auto_bump_stall` line with `heldCount` and `overThreshold` is logged whenever the set
of PRs past the threshold changes.

`/prs` shows the held PR as non-exempt: an Automerge button and an Awaiting approval
badge titled with the hold reason (`approvalHoldReason`).

The verdict is cached per PR head (`autoBumpGateVerdict`, 15-minute TTL, 500
entries) so `/prs`, the ci-fixer and the PR dispatcher share it; each sweep's
`tryMerge` recomputes it from the files it already read, so the merge never acts on
a stale verdict. A PR with no head SHA is never cached.

## Image-scan snapshot and prune PRs

The weekly `image-cve-scan.yml` in production-infra and fleet-infra opens two
generated PRs, recognised by exact branch name — labels play no part
(#clw_01M61EFZ6ZZM8FWGN2PAH3KNZB, `src/image-scan-prs.ts`):

- **Snapshot refresh** on `automation/image-scan-advisories` (production-infra
  only). Approval-exempt only while its changed files are exactly
  `security/image-scan/advisories.json`.
- **Exception prune** on `automation/image-scan-exceptions-prune`. Approval-exempt
  only while it is still the generator's output, checked in this order:
  1. its changed files are exactly `security/image-scan/exceptions.yaml`;
  2. its body records the commit the source scan ran on, as a line matching
     `/^image-scan-scanned-commit:\s*([0-9a-f]{40})\s*$/m` — the contract the prune
     workflow emits (#clw_01M61EGJAB6D6VZTYVCC4VVDKY); a prune without it is never exempt;
  3. it has exactly one commit, with one parent, and that parent is the scanned
     commit — so no conflict-resolution merge and no commit beyond the generator's;
  4. no image pin under the rendered manifests moved on the base branch between the
     scanned commit and the base branch's **current tip** (the PR's `base.sha`). The
     tip, not the merge base: with rule 3 the merge base is the scanned commit, so
     checking up to it would prove nothing. Claws lists the range with
     `/compare/{scanned}...{base}` and fetches the diff of each commit that touches a
     `.yaml`/`.yml` file under `apps/`, `infrastructure/`, `clusters/`, `data/` or
     `migrations/`; a `+`/`-` line matching the auto-bump gate's `PIN_LINE` (`image:`,
     `newTag:`, env `value:`) or containing `@sha256:` is a pin change.

An exempt image-scan PR still needs a clean Claws review of its current head
(advisory-only counts as clean), green CI and every later gate; the PR dispatcher
keeps reviewing it. The dispatcher pushes no advisory-nit commits to either branch
and never sends a prune PR to the conflict fixer (it logs
`Skipping conflict fixer for <repo>#<n> — generated prune PR; the weekly scan regenerates it`):
either would turn a generated PR into a held one. The next weekly scan regenerates
the prune against main instead.

A failing gate withdraws only the exemption: with a stored merge approval (the PR's
own, or its issue approved through Merge) the PR merges like any other approved PR.
Without one it is skipped with code `image-scan-gate`, logged as
`skipped: not approved — <hold text>; approve the merge from the Claws dashboard`,
and the same text titles the `/prs` Awaiting approval badge (`approvalHoldReason`).
The hold texts:

| Hold text | Reported on the PR |
|---|---|
| `snapshot PR changes files other than security/image-scan/advisories.json: <files>` | yes |
| `snapshot PR has no readable changed files` | no — may be a transient read failure |
| `prune PR changes files other than security/image-scan/exceptions.yaml: <files>` | yes |
| `prune PR records no scanned commit` | yes |
| `prune PR carries a conflict-resolution merge` | yes |
| `prune PR has commits beyond the generator's` | yes |
| `prune PR's scanned commit <sha7> is not on main` (the compare answered 404) | yes |
| `prune scan predates image-pin changes on main (<paths>)` (up to five paths) | yes |
| `could not verify main's image pins since the scanned commit` | no — a failed read, a truncated compare (fewer commits listed than `total_commits`) or more than 50 manifest-touching commits |

Reported holds edit the PR's `### Merge blocked` comment and mark it as needing the
operator on `/prs`. Verdicts share the auto-bump gate's per-head cache
(`${gate}:${repo}#${n}@${head}`, 15-minute TTL, 500 entries); the two log-only
reasons are never cached, and each sweep recomputes the verdict against the live head
and base tip.

## Infra paths and the no-op plan exception

Any PR touching an infra path (`gh.isInfraPath`: `tofu/`/`terraform/`, `*.tf`,
`*.tfvars`, `.terraform.lock.hcl`, a `.github/workflows|actions/**` or `.forgejo/workflows|actions/**` file naming tofu or terraform)
is held for a human merge (#2275). A plan comment alone never gates a merge: it
is spoofable, absent whenever the plan job failed, and a workflow-only change
that never planned destroyed two prod servers (production-infra#841). The gate
outranks a merge approval and every exemption, with one narrow exception.
Forgejo workflows get the same protection as GitHub ones: production-infra's tofu
apply is push-triggered on its own `.forgejo/workflows/` path, so a merged edit
applies at once.

A PR merges without a human when its diff is a provider bump and its plan for
the live head is a verified no-op (production-infra first). Until #clw_01M5VW1FVEPCYG33BN268PWTWZ
a GitHub path also accepted a trusted dependency PR whose every file was a
provider pin; it went with GitHub as a managed forge.

- Any author, Claws' own implementer included, but the PR needs the stored merge
  approval like any other non-exempt PR; approval-exempt
  Renovate PRs stay exempt.
- `providerBumpDiffVerdict` in `src/tofu-plan.ts` passes the diff: every changed
  file is a pin file, an existing `.tf`/`.tfvars` file whose added and removed
  lines are all blank or `#`/`//` comments, or a docs file (`isCiExemptPath`,
  outside any `tofu/` or `terraform/` directory). Any file under
  `.github/workflows` or `.forgejo/workflows`, any other file, an added, deleted
  or renamed `.tf` file, a `.tf.json` file or an unreadable diff fails it.
- `gh.getTofuPlanEvidence` reads the plan comment with the newest `updatedAt`, by
  any author — production-infra's workflow posts it with a user token, and a
  forged comment is outside the threat model. It counts only when it was last
  edited at or after the head commit's committer date (the workflow PATCHes one
  comment in place, so `updatedAt` moves on every run) and the head carries a
  passing commit status whose context starts with `Tofu Plan /`
  (production-infra's is `Tofu Plan / plan (pull_request)`). A repo without that
  workflow never has evidence and stays held.

It then needs:

- The comment to read as zero changes: production-infra's
  `**0 to add, 0 to change, 0 to replace, 0 to destroy.**`, or OpenTofu's
  `No changes. Your infrastructure matches the configuration.` A raw
  `Plan: N to add, N to change, N to destroy.` line is read too, with `replace`
  counted from `# … must be replaced` lines and any other term (`to import`)
  counted as a change; a body with neither form is unparseable.
- A clean Claws review of the current head, and CI
  `passing` — `status=none` is not accepted, since the plan run is itself a
  check — then the held-run, conflict and merge-window gates every PR runs.

Immediately before merging under the exception, the auto-merger creates and adds
the `claws-noop-merge` label (`CLAWS_NOOP_MERGE_LABEL`). production-infra's
merge-time `tofu-apply.yml` re-plans on push; for a merged PR carrying that label
it refuses any plan that is not zero changes — on the initial plan and on every
retry re-plan — and fails the run saying it refused, so drift no human saw is
never applied. Human-merged PRs and manual dispatches are not subject to it. If
the label cannot be added, the merge is skipped that cycle
(`skipped: could not label the PR for the no-op apply guard`, log-only).

Anything else fails closed. A diff that is not a provider bump logs
`skipped: infrastructure changes require a human merge (…); no-op plan exception
does not apply: <reason>`, and the Merge blocked comment on an approved PR reads
`Infrastructure changes (…) always need a human merge. The no-op plan exception
does not apply: <reason>.` — the reason names the file, e.g.
`non-comment change in tofu/data-server.tf`, `changes workflow file
.forgejo/workflows/tofu-apply.yml`, `tofu/files/x.yaml is not a provider pin,
comment-only .tf edit or docs file` or `diff unreadable`. A plan with changes
logs `skipped: infrastructure plan shows N changes, human merge required (…)`; a
missing, unparseable, failed, cancelled, running or stale plan logs
`skipped: infrastructure plan not available for head <sha7> (<detail>)`
(log-only, no Merge blocked comment — it usually resolves on a later sweep). The
detail is `no plan comment`, `plan comment is not parseable`,
`head commit date unknown`, `plan comment predates the head commit`,
`Tofu Plan check is <state>` or `no Tofu Plan check on this head`. A verified
no-op logs
`no-op Tofu plan verified for head <sha7>; allowing a no-op provider bump merge`.
`/prs` shows the same verdict as one line after the infra badge: `Plan shows N
changes — human merge required`, `Plan not available for this head: <detail>`,
`No-op plan — human merge required (<reason>)` naming why the diff is not a
provider bump, or `No-op plan — merging on next cycle`. The dashboard's own
**Merge infra** button still needs its confirm dialog (`confirmInfra`).

A session holding the operator-granted `infra-merge` capability is the other
human merge: its `claws_merge_pr` / `claws_approve_pr_merge` passes
`infraMergeBy` to `attemptMerge`, which skips this gate (both the plain refusal
and the provider-bump plan path) but still requires a clean Claws review of the head,
even for an approval-exempt PR, and then every later gate. `tryMerge` and the
sweep never pass it, so the headless auto-merger still refuses infra PRs.

## Merge-blocked status comment

Once `tryMerge` knows a PR is human-approved — its `claws_prs` row carries a merge
approval with a named approver — any
later gate that stops the merge is reported:

- A single Claws comment headed `### Merge blocked`, ending with the
  `claws-merge-status` marker, states the reason (a recorded manual action,
  review not clean, stale review, unreadable changed files, infra paths, CI
  failing or unfinished, N workflow runs held for approval, merge conflicts,
  or a doc/ideas content mismatch). A recorded manual action is
  checked first and reported whenever the row also carries a merge approval,
  before the review and CI gates run; the comment names the recorded reason
  and how to clear it once the step is done: the dashboard's **Clear manual
  action** button or a session's `claws_clear_pr_manual_action` tool; moving
  the linked issue out of `Blocked` does not lift it. No forge label carries it
  (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK). A reviewer escalation records the reason as
  `review escalated: <summary>`, so the comment and badge say what the human
  must settle; approving the merge does not clear it, because the escalated review
  verdict still blocks the merge; the reason clears when a later review round
  is clean or advisory-only. It is edited in
  place when the reason changes, left untouched when the text is unchanged,
  and left in place after the PR merges.
- The same reason is kept in memory (`gh.setMergeBlockReason`, 1-hour TTL,
  cleared on merge) and shown as a `⚠ Merge blocked` badge on
  `/prs`. After a restart the badge is empty until the next sweep.

Apart from an auto-bump PR held because its diff fails the auto-bump gate (see
[Auto-bump PRs](#auto-bump-prs)), nothing is reported before approval is established — fork, no `claws_prs` row, a
recorded manual action on an unapproved PR, closed, dispatch guard, or no merge approval — or for four transient
states: no checks registered yet on a fresh head, mergeability still `UNKNOWN`
after retries, the head moving between evaluation and merge, an
approved PR whose Claws review status is still `none` — no review of the
current head has run yet (#3122).

Approval-exempt PRs (`claws/docs-`, `claws/ideas-collect-`,
auto-bump, trusted non-major Renovate) are `approved` only when their row carries a
dashboard merge approval; in that case a later block is reported like any approved
PR's. An unapproved exempt PR's blocks stay log-only — failing CI, infra paths, a
docs PR containing non-doc changes — so the job log is the only place that reason
appears. An auto-bump PR whose diff fails the auto-bump gate is not exempt at all,
and its hold is reported (see [Auto-bump PRs](#auto-bump-prs)).

An approval never adds a review gate to an exempt PR: `isApprovalExempt` is evaluated
before the merge-approval branch, so an approved docs PR merges on green, settled CI
with no Claws review (#clw_01M46YW6WPNPH0545G6KJB1AWD — bonkus #1956–#1958, then
Dependabot PRs, waited 10–15 minutes for reviewer runs after Automerge was pressed on
2026-10-05, while unapproved ones merged at once). A trusted Renovate PR keeps its review gate, approved or not.
`/prs` shows an **Approval-exempt** chip instead of an Automerge button on these rows.

## Post-merge cleanup for `claws/issue-…` PRs (#3338)

Merging a `claws/issue-<id>-…` PR runs two independent steps
(`finalizeMergedClawsPR` in `src/agents/auto-merger.ts`). This runs for every
merge route, not just this job's own:

- `tryMerge` calls it after a merge it performs itself.
- The dashboard's `POST /queue/merge` calls it after `mergePR` succeeds — a
  cleanup failure there is logged but does not fail the merge response.
- A PR a human merged directly on Forgejo is caught by the PR
  dispatcher's `refreshPrStore`: when a `claws_prs` row linked to an issue
  moves to `merged`, it calls the same cleanup, tagged `hand-merge` in the
  logs (see [pr-dispatcher.md](pr-dispatcher.md)).

The cleanup is idempotent, so running it twice for one merge is harmless.

- **Multi-PR completion**: `loadMergedIssuePhases` reads the issue's phase
  state (its primary repo for a native id) and, once every step is merged or
  claimed and the issue is still open, `closeCompletedMultiPRIssue` posts one
  Implementer comment and closes it as `completed` — steps of a parallel plan
  can merge in any order, so the PR that completes the plan may carry no
  `Closes` line at all. A single-phase plan skips this read entirely, and a
  failed read only logs; the issue-auditor is the backstop.
- **`closeNativeIssuesClosedBy`** honours any `Closes #clw_…` line for
  Claws-native issues, re-reading the PR body rather than trusting a cached
  copy.

`sweepRepo` itself no longer reads issues at all: the `In Review` label and
the reconciling sweep that cleared it were retired
(#clw_01M39G3H99HV6ED4378ZXHER6K). An issue whose PR closed unmerged goes back
to Awaiting plan review on `issue-auditor`'s next daily run.

## Skip reason codes

`claws_recent_job_logs` redacts free-text log messages and returns only the
structured `diagnostic_reason` and `diagnostic_context`, so each skip carries a
`mergeSkip` code (`MergeSkipCode` in `src/agents/auto-merger.ts`) alongside
its human-readable line (#clw_01M4TK4C1E6VHMC09T13HDCBHJ):

| Code | Meaning |
|---|---|
| `fork` | Fork PR |
| `no-record` | No `claws_prs` row |
| `manual-action` | A manual action or reviewer escalation is recorded |
| `stacked` | A `claws/` PR targets a branch other than the default |
| `reapproval-hold` | Held by a design change on its issue |
| `closed` | Live state is not `OPEN` |
| `dispatch-guard` | `isDispatchSkippable` rejected it (from the PR list or live labels) |
| `other-work` | A ci-fixer, conflict fixer, review-addresser or reviewer is running on it |
| `review-not-clean` / `review-stale` | A required clean review of the current head is missing |
| `auto-bump-gate` | An auto-bump PR failed `checkAutoBumpDiff` and has no approval |
| `image-scan-gate` | An image-scan snapshot or prune PR failed its gate and has no approval |
| `not-approved` | Not approval-exempt and no stored merge approval |
| `unreadable-files` | Changed files could not be read |
| `infra` / `infra-plan` | Infrastructure paths, or a Tofu plan with changes or none for the head |
| `doc-pr-mixed` / `ideas-pr-mixed` | A docs or ideas PR with other files |
| `checks-pending` / `checks-failed` / `checks-held` | CI not finished (or not yet registered on a fresh head), failing, or held for approval |
| `checks-missing` | A settled head has no CI result, nothing carries one forward, and the repo's CI normally reports on PRs |
| `conflict` / `mergeable-unknown` | Merge conflicts, or mergeability still `UNKNOWN` |
| `head-moved` | The head moved or was unmergeable at merge time |
| `error` | `tryMerge` threw (logged at warn) |

Query them with `claws_recent_job_logs` and `job_name: "auto-merger:sweep"`:
that filter also matches the `auto-merger` scheduler job, which runs the
sweep for every repo, and the `work:auto-merger:sweep` queue runs. There is
one `merge_sweep_done` entry per repo per sweep, about every three minutes.
Queue rows exist only for sweeps chained after an agent run, so a repo with no
`auto-merger:sweep` rows in the work queue is still being swept.

## Restart durability

Chained `auto-merger:sweep` rows live in `work_queue` on both SQLite and
Postgres, so they survive a restart; `recoverWorkOnStartup` requeues any row
left `running`. The scheduler job needs no recovery — it simply runs again
after boot. The hand-merge close-out is driven by
the `claws_prs` rows, so a merge that happens across a restart is picked up on
the PR dispatcher's next tick.
