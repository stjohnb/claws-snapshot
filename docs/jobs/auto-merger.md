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
itself. An infra PR merging on verified plan evidence is never
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
`claws/docs-`, `claws/ideas-collect-` and auto-bump. A merge approval on any of these never adds a review gate (the Renovate and auto-bump review gate applies approved or not):

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

An `auto-bump` PR (`isAutoBumpPR`: an `automation/bump-*` branch with the
`auto-bump` label and no `major-update` label) is approval-exempt
unconditionally; nothing reads its diff (#clw_01M6ZYAQ1GZXRMTZSQP1V0XA4D). Like
a trusted Renovate PR it still needs a clean Claws review whose reviewed commit
prefixes the current head, logging `skipped: auto-bump image bump but review
status=…` or `… but clean review is stale` otherwise, followed by the infra, CI,
deploy and conflict gates every PR runs. A `major-update` bump is not exempt and
needs a stored merge approval. A row with `needsHumanReview` still blocks it.

The PR dispatcher sends auto-bump PRs to the reviewer like any other PR, so a
fresh bump head is reviewed before it merges. On a fresh head with no review yet
the skip is the quiet `review-not-clean` (`review status=none`), not reported on
the PR.

Once per repo per process the sweep closes any still-open
`Auto-bump PRs held by the structural merge gate` issue left by the removed
stalled-bump alert (retirement; delete after 2026-12-01).

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
     `migrations/`; a `+`/`-` line matching `PIN_LINE` (`src/image-scan-prs.ts`: `image:`,
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
operator on `/prs`. Verdicts are cached per head
(`${gate}:${repo}#${n}@${head}`, 15-minute TTL, 500 entries); the two log-only
reasons are never cached, and each sweep recomputes the verdict against the live head
and base tip.

## Infra paths and the verified-plan gate

Any PR touching an infra path (`gh.infraPathsIn`: `tofu/`/`terraform/`, `*.tf`,
`*.tfvars`, `.terraform.lock.hcl`, a `.github/workflows|actions/**` or `.forgejo/workflows|actions/**` file naming tofu or terraform,
or the repo's plan-publishing files) merges only on the trusted plan evidence for its live head
(#clw_01M7NKT2H402M07VGCAE1TBX8G, replacing the blanket human merge of #2275).
Two rules leave out `.tf`-like files nothing can apply (#clw_01M7QQ828D0HWPZ4RVFGPN7DBE):

- **Test fixtures:** a `*.tf`, `*.tfvars`, `*.tf.json` or `.terraform.lock.hcl`
  file under a `testdata/`, `fixtures/`, `__fixtures__/`, `test/`, `tests/` or
  `__tests__/` directory (`isTestFixturePath`) is not infra code, unless it also
  sits under a `tofu/` or `terraform/` directory (`tofu/tests/x.tf` stays infra).
- **No tofu pipeline:** in a repo with no tofu pipeline (`gh.repoHasTofuPipeline`:
  no entry under `.forgejo/workflows`, `.github/workflows`, `.forgejo/actions` or
  `.github/actions` on the default branch names tofu or terraform, and no
  workflow file's content mentions either), `.tf`-like files are not infra code
  either — unless the PR also changes any workflow or action file, so a PR that
  adds a repo's first tofu workflow with its first `.tf` files is still gated.
  The answer is read live and cached per repo (1 hour when true, 10 minutes when
  false); a read error counts as having a pipeline and is not cached. The lookup
  runs only for a PR that changes a non-fixture `.tf`-like file.

Tofu workflow edits (`isInfraWorkflowPath`) and plan-publishing files
(`isPlanPublishingPath`) count in every repo.
It first passes the approval gate like any other PR: a stored merge approval,
or an approval exemption (trusted non-major Renovate, auto-bump, image-scan,
doc). Then `attemptMerge` reads `gh.getTofuPlanEvidence` and asks
`infraApprovalNeed` (`src/tofu-plan.ts`) which per-head board approval the PR
needs, checked in this order:

- `unverified` — the evidence is neither `noop` nor `changes`, or has no counts.
- `destructive` — the verified plan destroys or replaces anything in any root
  (`formatInfraSummary(plan).destructive`).
- `workflow` — the PR edits a tofu-named workflow or action file
  (`isInfraWorkflowPath`). A plan cannot show what an edited apply workflow will
  do (production-infra#841; production-infra's tofu apply is push-triggered on
  its own `.forgejo/workflows/` path, so a merged edit applies at once). The one
  exception is a trusted tool bump: `noopMergeDiffVerdict` says
  `tool-version-bump` (every infra path is a tofu-named workflow or action file
  whose section has exactly one removed and one added line, identical once one
  version token `v?N.N(.N)*` with an optional `-`/`+` suffix in each is replaced,
  the file not added, deleted or renamed), the PR is a trusted non-major
  Renovate update (`isRenovateExempt`), and the plan is `noop`. The diff is read
  only when a tofu workflow file changed (or a stale approval needs carry-over).

No need — a verified plan that destroys or replaces nothing — merges like any
other PR: it needs a clean Claws review of the head (approval-exempt PRs
included), logs `head <sha7> has a verified non-destructive plan (<detail>[, trusted Renovate
tool version bump]); checking the remaining gates`, and goes on through every later gate. CI must be
`passing`: `status=none` never stands in for green on a merge that relies on
verified evidence, since the plan run is itself a check.

`gh.getTofuPlanEvidence` groups the plan comments by root (fleet-infra's
`### Tofu Plan: <dir>` heading; no heading is the one default root) and takes
the newest per root. Only comments from the forge's Actions account
(`forgejo-actions`) or a configured human operator (`isAllowedHumanActor`;
production-infra's workflow posts with a user token) count; other accounts,
Claws' own included, are ignored before the newest-per-root pick. Every root's
comment must parse and be last edited at or after the head commit's committer
date (the workflow PATCHes one comment in place, so `updatedAt` moves on every
run), and the head must carry a passing commit status whose context starts
with `Tofu Plan /` (production-infra's is `Tofu Plan / plan (pull_request)`).
The counts are summed over the roots: production-infra's
`**0 to add, 0 to change, 0 to replace, 0 to destroy.**` line (fleet-infra adds
a `**N to import**` span before it, counted as a change), OpenTofu's
`No changes. Your infrastructure matches the configuration.`, or a raw
`Plan: N to add, N to change, N to destroy.` line with `replace` counted from
`# … must be replaced` lines. A repo with no tofu pipeline never has evidence,
so its `.tf`-like files are not infra paths at all (see above); only a tofu
workflow or plan-publishing edit, or `.tf` files beside a workflow edit, makes
such a repo's PR an infra PR that needs the board approval.

A need with no board approval for the head blocks:

- `unverified` → `infra-plan`, log-only (no Merge blocked comment; it usually
  resolves on a later sweep): `The Tofu plan for head <sha7> could not be
  verified (<detail>), so Claws will not merge it. It merges once the plan run
  passes; approve it on the board to merge without a verified plan.` The detail
  is `no plan comment`, `plan comment[ for <root>] is not parseable`, `head
  commit date unknown`, `plan comment[ for <root>] predates the head commit`,
  `Tofu Plan check is <state>` or `no Tofu Plan check on this head`.
- `destructive` → `infra`: `The Tofu plan for head <sha7> destroys or replaces
  N resource(s):`, one `- <root>: <address> — <action>` bullet per destroyed or
  replaced entry of the evidence's resources (`isDestructivePlanAction`), then
  `Approve resource deletion on the board to merge it.` When the plan comment
  lists no addresses it gives the destroy and replace counts instead.
- `workflow` → `infra`, naming the tofu workflow files and saying the plan
  cannot show what the edited workflow will apply.

`/prs` and the repo page show the verdict as one line after the infra badge
(`buildInfraHoldNote`): `Verified plan — merges like any other PR`, or which
approval is needed. The dashboard's own **Merge infra** button
(`POST /queue/merge` with `confirmInfra`) is the operator's direct merge and
still needs its confirm dialog.

### Apply-guard labels

Immediately before merging an infra PR on verified evidence, the auto-merger
labels it for production-infra's merge-time `tofu-apply.yml`, which re-plans on
push:

- `noop` evidence adds `claws-noop-merge` (`CLAWS_NOOP_MERGE_LABEL`): the apply
  refuses any plan that is not zero changes, on the initial plan and every
  retry re-plan.
- `changes` evidence removes any `claws-noop-merge` first (a failure skips the
  cycle, fail closed) and, when `gh.getTofuPlanResourceEvidence` is available,
  adds `claws-ack-merge` (`CLAWS_ACK_MERGE_LABEL`): the apply refuses any
  change the PR's plan comment did not list. The resource evidence is each
  root's fenced `tofu-plan-resources` block (`readTofuPlanResourceBlock`: the
  comment has its counts, is not `Output truncated`, names the same root as its
  heading, and the block accounts for the counts). Without it the label is
  removed. After the merge it posts one PR comment: `Merged on the verified
  Tofu plan for head <sha7>. Labelled claws-ack-merge, …`.
- A merge on a board approval of an unverifiable plan removes both labels.

A label that cannot be added skips the merge that cycle (log-only), and a merge
the forge rejects removes the apply-guard labels (`claws-noop-merge`,
`claws-ack-merge`) again. The trade-off the
operator accepted for zero-change plans stands: a template edit such as the
tailscale `_common_tailscale.sh.tftpl` bump (production-infra #527, #708) can
plan as zero because the rendered `user_data` is `ignore_changes`, and only
takes effect at the next server rebuild.

### Board approvals and plan-neutral commits

The board's infra approval button (`/board/infra-approve`) shows only when the
approval is the PR's next step: while a merge-blocking job
(`MERGE_BLOCKING_AGENT_KINDS`) is queued or running for the PR, CI on its head is
pending or failing, its head has no Claws review or a blocking one, or it
conflicts, the card shows what it waits on instead (`infraApprovalWait`,
#clw_01M7QNXX7VNQXA1A92P1WCT6S9). A PR with a recorded manual action
(`manual_action_reason`, any hold kind) shows "Infra approval comes after the
manual action" (or "… after the reviewer escalation is settled") instead of
the button until the hold is cleared (#clw_01M7QWS5TGJF46D318FN3W5HRJ); the
auto-merger refuses it with `manual-action` before the infra gate anyway. This
is presentation only; the gates below are unchanged and an approval recorded
earlier still applies. The button reads **Approve
resource deletion**, **Approve merge without a verified plan** or **Approve tofu
workflow change** by the need, and posts the need the button showed (a
request without one is a 400, so a tab loaded before the buttons named their
need reloads). The route recomputes the need from live evidence and refuses
with 409 `needs no infra approval` when there is none, or `<name> now needs a
different infra approval (<words>); review it and approve again` when the live
need differs from the posted one; either refusal answers a line drawn from the
need it just read. Otherwise it records the PR's merge approval too, and the approver and head on
the `claws_prs` row (`infra_merge_approved_*`), and in
`infra_merge_approved_evidence` the head's plan fingerprint
(`tofuPlanFingerprint` over `parseTofuPlanResources`: one `root address action`
line per resource, from production-infra's `` - `address` — **action** ``
bullets or raw `# address will be …` lines; null when the plan was not verified
or lists no resources) and `infraWorkflowDiffDigest` (sha256 of the PR's
tofu-named workflow and action files and their `+`/`-` lines, hunk headers and
context excluded), and the `need` the approval was given for. It logs which need was approved and whether a fingerprint
was recorded, then tries the merge.

An approval recorded for or carried over to the live head passes only when it
covers the head's live need (`infraApprovalCovers`): it was given for that
need, or, for a destructive plan, it recorded this very plan (same
fingerprint; a destructive approval whose plan listed no resources is taken on
its need). An approval recorded before the need was stored covers a
destructive plan only by fingerprint, and `unverified` or `workflow` as
before. So an **Approve merge without a verified plan** click never covers a
destroy the plan run reports later on the same head, and a carried approval is
re-checked on every sweep in case a re-plan of that head now destroys
something. Otherwise the PR blocks with `The infra approval by <by> for <sha7>
does not cover what the head now needs. <hold reason>` (log-only while the
need is `unverified`). One for an older head is
carried over (`infraApprovalCarryOver`) when the live head's evidence is `noop`
or `changes` with resources, its fingerprint equals the stored one, and the
digest of the live PR diff equals the stored digest. The digest is taken from
the PR's own diff against its base, so a merge from the base branch alone, like
the CI-fixer commit on production-infra #706, keeps it. The auto-merger then
writes `infra_merge_carried_sha`/`_note`, logs `infra approval by <by> for
<X7> carried over to <Y7> (same plan as <X7>, no tofu workflow change)` and
merges like a current approval. Otherwise a head that still needs an approval
blocks as `infra-approval-stale` with `Infra approval not carried over: <rule>;
approve it again on the board.` The rule is one of `plan for <Y7>
differs from the approved plan for <X7>: now plans|no longer plans <address>
<action>`, `<file> changed since <X7>`, `plan for <Y7> not available
(<detail>)` or `approved plan for <X7> was not recorded` (every approval made
before this rule existed). The board card shows a carried approval as `Infra
approval by <by> for <X7>, carried over to <Y7> (<note>)`, and a stale one
as `Approval by <by> was for <X7>; head is now <Y7> — not carried over: <rule>`
(`waiting for the plan of the new head` until the auto-merger has judged it).

A plan that differs (totals or fingerprint; `infraApprovalCarryOver` returns
`kind: "plan-differs"` with the fingerprint lines on one side only as `drift`
and the evidence's `roots`) first tries an automatic branch update
(#clw_01M7JEVQFZHD8BT8BVMFAJ3MT5). It is made when `driftOutsidePr` holds
(every drifting root is named, no changed file sits under `<root>/`, and every
changed infra code file sits under some other plan root), the head branch
starts with `claws/`, `infra_branch_updates` is under 2, and
`listCompareCommits(head, base)` lists commits the head lacks. Claws then calls
`updatePRBranch` (Forgejo `POST /pulls/{n}/update?style=merge`), stores the
count, the new head and the head it started from in
`infra_branch_updates`/`infra_branch_update_sha`/`infra_branch_update_from_sha`,
records the push with `recordCIFixerPush`, logs `[auto-merger] updated infra
PR branch onto its base` with `repo`, `pr`, `base`, `behind`, `attempt` and
`head`, and blocks as `infra-branch-update`: `Claws merged <base> into this
branch (it was N commits behind) because the plan drift (<address> <action> in
<root>) is outside the files this PR changes; waiting for the Tofu plan of
<sha7>. Automatic update K of 2.` A new head that cannot be read after the
update (or reads unchanged) is stored as null, logged at `warn`, named `the
updated head` in the reason, and records no push. While the live head differs
from `infra_branch_update_from_sha` (the update's merge commit or any later
push onto it) and its plan is unavailable, the sweep keeps the
`infra-branch-update` block instead of asking again, reusing the update
sweep's reason while the head is the one it named and otherwise `Claws
updated this branch onto <base> (automatic update K of 2); waiting for the
Tofu plan of <sha7>.` If that head's checks are failing the re-plan will not
report, so the PR falls through to `infra-approval-stale` with `The re-plan
after the automatic branch update did not report: checks on <sha7> are
failing.` Once the plan matches the approved plan, the approval carries over
and the PR merges after a clean review of the new head and green checks.
Otherwise the `infra-approval-stale` reason gains one sentence, chosen by
`driftOutsidePr`'s result or the later check that stopped the update: the
plan totals differ but no resource line does (`no-drift`), the plan names no
root per change (`unnamed-root`), the drift is in a root this PR changes
(`drift-in-pr-root`), the PR changes infra code outside every plan root such
as a shared module (`infra-outside-roots`), the PR changes no infra code
under a plan root (`no-infra-code`), the branch is up to date
with its base, it is behind but not a Claws branch, it is behind and conflicts
with its base (HTTP 409), the update failed (logged at `warn`, retried next
sweep), or `the branch is N commits behind <base> and 2 automatic updates were
already attempted`. A conflict or failure spends no budget. A board approval
resets the count to 0. A base that moves while the head stays put needs no
trigger: the next sweep finds the branch behind.

Only the board approval passes this gate; a session's `claws_merge_pr` /
`claws_approve_pr_merge` meets it like the sweep does. The `infra-merge`
session capability that once stood in for it is retired
(#clw_01M7NKT2H402M07VGCAE1TBX8G): a request for it gets a denial naming the
retirement, and the controller strips it from stored grants at boot.

### Destroys and the planner's declaration

The Planner declares, per planned PR that changes infra in a repo with a `Tofu
Plan` workflow, the Tofu changes it expects: `claws_save_plan`'s optional
`prs[].infra_changes` `{resources: [{root, address, actions}], workflow_files}`,
validated by `validateInfraDeclaration` (`src/infra-declaration.ts`) and stored
as JSON in `claws_issue_prs.infra_changes`. Approving the plan turns its
declared `replace` and `destroy` addresses into the destroy consent the repo's
destroy guard checks (below). That consent is not the deletion approval: a PR
whose verified plan destroys or replaces anything still waits for **Approve
resource deletion** on the board for its head. The plan-stage acknowledgement
of an issue's infra changes (#clw_01M7096B0VFCVYAA2ED0ZRHFC2) is retired.

Claws never adds `allow-destroy` or `ack-rebuild`; a destroy the plan declared
passes the repo's destroy guard through the approved-destroys block below, and
any other fails the repo's `Tofu Plan` check, so its evidence stays
unavailable until the operator labels the PR `allow-destroy` in Forgejo.

## Approved-destroys sync

Approving an issue through Plan records the tofu destroy consent: a snapshot of
every planned PR's declared `destroy`/`replace` addresses
(`claws_issues.approved_destroys`, `src/destroy-consent.ts`), cleared by a
withdrawal below Plan or a re-plan (#clw_01M70H3K4B7H0SNSAB5XJ8ZFCJ). The
implementer writes the PR's share into the body it opens and labels the PR
`claws-approved-destroys`. The block is the marker comment and a fence per
root, under a `## Approved destroys` heading:

    <!-- claws-approved-destroys -->
    ```tofu-approved-destroys
    root: tofu
    aws_route53_record.example
    ```

The consent writers push a change out themselves: recording or withdrawing it
(`applyIssueApproval`) and a re-plan (`issue-refiner`'s planned-PR store,
`reapproval.ts`'s design-change approval, which also records the consent for
the revised plan when the issue ends up approved through Plan) call
`syncIssuePrsDestroyConsent`, which syncs every open PR of the issue, plus the
PRs the re-plan unlinked, best-effort; the board approval does not wait for
it. The sweep is the backstop. A plan that declares destroys, saved while the
issue is already approved through Plan, withdraws that approval to
Requirements: consent covers only a plan the operator approved.

On every `attemptMerge` (fork PRs are skipped), right after the `claws_prs`
row is read and before any hold or merge gate, `syncPrDestroyConsent` compares
the body's fence-closed blocks with the PR's planned entry's share of the
current snapshot (the entry linked to the PR, else the one at its phase). It
works off the PR list's labels and body, so a PR with no expected block, no
label and no marker in its listed body costs no forge call; any other reads
the live body. When the blocks differ — including a block nobody approved,
which an agent wrote into the body — the body is rewritten with the expected
section (or without one); the label is then added when the expected block is
non-empty, removed when it is empty, and removed then re-added when the
addresses changed. production-infra's `Tofu Plan` also re-runs on the body
edit; bstjohn-blog's runs only on a label change, so the toggle is what
re-plans there. Each change logs one
`synced approved destroys on PR` line with the outcome. A failure logs a
warning and the sweep carries on; the guard then reads the old block, which
fails closed on any mismatch. A sync that changed anything ends that attempt
with the pre-gate skip `destroy-consent-sync` (not persisted, not reported):
the CI status read before the sync predates the `Tofu Plan` run it triggered,
so the next sweep decides the merge. A PR the sweep skips before
`attemptMerge` (`dispatch-guard`, `other-work`) is synced there too. Only
Claws writes the block: the implementer's PR body and `regenerateAndUpdatePRBody`
(CI fixer, review addresser) strip any block from agent-written text, and the
regenerated body's section is rebuilt from the recorded consent rather than
carried from the old body. bstjohn-blog's and production-infra's
`assert-no-destroy.sh` pass a plan only when its destroy/replace set equals the
block's addresses; bstjohn-blog's reads the block only on a PR carrying the
label.

## Merge-blocked status comment

Once `tryMerge` knows a PR is human-approved — its `claws_prs` row carries a merge
approval with a named approver — any
later gate that stops the merge is reported:

- A single Claws comment headed `### Merge blocked`, ending with the
  `claws-merge-status` marker, states the reason (a recorded manual action,
  review not clean, stale review, unreadable changed files, infra paths, CI
  failing or unfinished, N workflow runs held for approval, merge conflicts,
  a doc/ideas content mismatch, or an automatic infra branch update made or
  skipped for a stale infra approval, and why). A recorded manual action is
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
  place when the reason changes and left untouched when the text is
  unchanged. Once the PR merges, by any route, `settleMergedPrState` edits it
  to `### Merged` ("This PR has merged; the block above no longer applies."),
  keeping the marker, and clears the row's merge skip and the queue entry.
- The same reason is kept in memory (`gh.setMergeBlockReason`, 1-hour TTL,
  cleared on merge) and shown as a `⚠ Merge blocked` badge on
  `/prs`. After a restart the badge is empty until the next sweep.

Apart from an image-scan PR held because its diff fails the image-scan gate (see
above), nothing is reported before approval is established — fork, no `claws_prs` row, a
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
appears.

An approval never adds a review gate to an exempt PR: `isApprovalExempt` is evaluated
before the merge-approval branch, so an approved docs PR merges on green, settled CI
with no Claws review (#clw_01M46YW6WPNPH0545G6KJB1AWD — bonkus #1956–#1958, then
Dependabot PRs, waited 10–15 minutes for reviewer runs after Automerge was pressed on
2026-10-05, while unapproved ones merged at once). A trusted Renovate PR keeps its review gate, approved or not.
`/prs` shows an **Approval-exempt** chip instead of an Automerge button on these rows.

## Red deploy on an earlier step

A plan step that depends on an earlier, merged step does not auto-merge while
that earlier step's deploy is red (#clw_01M6RPD77S4VCG7068KVFN4GEF). A repo
names its deploy workflows in `claws.json` as `deployWorkflows` — Forgejo
workflow file names such as `tofu-apply.yml` ([repo-config.md](../repo-config.md)).

`deployGateBlock` (`src/deploy-gate.ts`) runs in `attemptMerge` after every CI
gate has passed and just before the mergeability check, so only a PR that is
otherwise ready costs the extra reads. It walks the transitive dependencies of
the PR's step in the issue's plan. For each one a merged PR covers, it reads
that PR's merge time and its own repo's `deployWorkflows` — a cross-repo step
uses the dependency's repo — and for each workflow takes the newest run on
that repo's default branch created at or after the merge, ignoring
`cancelled` and `skipped` runs and pull-request-triggered runs:

- `failure` holds the merge as `deploy-red`. The `### Merge blocked` comment
  names the step, the dependency PR, the merge time, the workflow and the
  failed run, and says Claws will merge once a later run succeeds; it is
  reported even on an unapproved PR. The linked issue gets one
  `## Waiting on a red deploy` comment per held PR and failed run, carrying a
  `claws-needs-human:` marker so a restart does not repeat it. The PR shows
  in Needs-you on the dashboard (`OPERATOR_MERGE_BLOCK_CODES`), but the
  issue is not parked in Blocked — its other steps carry on.
- A queued or running newest run holds quietly as `deploy-pending`, so a
  step never merges mid-apply.
- `success`, or no run since the merge, does not hold.

A Forgejo read error fails closed as `deploy-pending` with a `warn` log.
Nothing is stored as a manual action: each sweep re-checks, and the hold lifts
by itself once a later run of the workflow passes. Only the merge is held; the
step is still implemented and reviewed, since building it early is harmless.
An operator can still merge the PR by hand on Forgejo.

The runs are read per workflow (`actions/runs?workflow_id=…`), because this
Forgejo ignores `limit` on that endpoint and an unfiltered read returns the
repo's whole run history.

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
  logs, passing the row's `issueId` since it has no branch name on hand
  (see [pr-dispatcher.md](pr-dispatcher.md)). This is how the operator merges
  past a CI or review gate: in the Forgejo UI, never from the dashboard.

The cleanup is idempotent, so running it twice for one merge is harmless.

- **Multi-PR completion**: `loadMergedIssuePhases` reads the issue's phase
  state (its primary repo for a native id) and, once every step is merged or
  claimed and the issue is still open, `closeCompletedMultiPRIssue` posts one
  Implementer comment and closes it as `completed` — steps of a parallel plan
  can merge in any order, so the PR that completes the plan may carry no
  `Closes` line at all. A single-phase plan skips this read entirely, and a
  failed read only logs; the issue-auditor is the backstop.
- **Post-merge note**: before this cleanup, `tryMerge`'s `announcePostMergeAction`
  posts a merged PR's "Manual action required after merge" note as a PR
  comment and turns it into an operator step on its issue's plan
  (`recordPostMergeStep` in `src/post-merge-step.ts`), so a single-PR plan
  becomes a two-step one and the multi-PR completion step above parks the issue awaiting
  the operator instead of closing it. A note the issue cannot take (closed, or
  its operator step already marked done) becomes a Blocked follow-up issue; a
  PR with no linked issue keeps only the comment.
- **`closeNativeIssuesClosedBy`** honours any `Closes #clw_…` line for
  Claws-native issues, re-reading the PR body rather than trusting a cached
  copy. It leaves open (logged at `info`) an issue whose stored step list has
  an operator (`manual`) step not yet claimed done; the plan closes it once the
  step is marked done.

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
| `image-scan-gate` | An image-scan snapshot or prune PR failed its gate and has no approval |
| `not-approved` | Not approval-exempt and no stored merge approval |
| `unreadable-files` | Changed files could not be read |
| `infra` / `infra-plan` | An infra PR needing the board's infra approval: a destructive plan or a tofu workflow edit (`infra`), or a plan that cannot be verified for the head (`infra-plan`) |
| `infra-approval-stale` | A board infra approval for an older head did not carry over |
| `infra-branch-update` | Claws updated a stale infra approval's branch onto its base and waits for the re-plan; not an operator block |
| `doc-pr-mixed` / `ideas-pr-mixed` | A docs or ideas PR with other files |
| `checks-pending` / `checks-failed` / `checks-held` | CI not finished (or not yet registered on a fresh head), failing, or held for approval |
| `checks-missing` | A settled head has no CI result, nothing carries one forward, and the repo's CI normally reports on PRs |
| `deploy-red` | An earlier plan step's deploy workflow failed on its default branch since that step merged (see [Red deploy on an earlier step](#red-deploy-on-an-earlier-step)) |
| `deploy-pending` | An earlier plan step's deploy workflow is still queued or running since that step merged, or its runs could not be read |
| `conflict` / `mergeable-unknown` | Merge conflicts, or mergeability still `UNKNOWN` |
| `head-moved` | The head moved or was unmergeable at merge time |
| `empty` | The PR has no net changes against its base (0 files, 0 additions, 0 deletions); the Empty PR Closer closes it |
| `base-covers-update` | Base commits the head lacks changed every file the PR changes, so Claws merged the base into the branch and waits for checks on the new head. Forgejo's diff stats are against the merge base, so a PR already on the base looks non-empty (and its squash merge fails with HTTP 500) until its branch is updated; a PR left empty is then skipped as `empty`. Fork PRs and image-scan prune PRs are never updated this way: a merge commit on a prune branch would cost it its approval exemption, and the weekly scan regenerates the prune against the base anyway. Not an operator block |
| `ci-queue-deep` | Base commits covered every changed file, but the repo has `CLAWS_CI_QUEUE_HOLD_JOBS` or more non-Mac Actions jobs that have waited at least 5 minutes, so Claws holds the branch update (it would start another CI run) until the queue drains. Never posts a "Merge blocked" comment; a Priority PR is not held. A stale infra approval's branch update is held the same way, spending none of its update budget and asking for no re-approval: the PR is blocked quietly as `ci-queue-deep` with the reason `The branch is N commits behind <base>; Claws waits to update it until <repo>'s CI queue drains.` See [CI queue gate](pr-dispatcher.md#ci-queue-gate). Not an operator block |
| `destroy-consent-sync` | The approved-destroys sync just changed the PR's block or label, so `Tofu Plan` re-runs; the next sweep decides (not persisted) |
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
