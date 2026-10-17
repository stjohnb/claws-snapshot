# Automation lifecycle

**Reference.** Read this when changing how Claws discovers, plans, implements,
reviews, merges, or onboards repository work. Read [interactive sessions](interactive-sessions.md)
instead for a human-operated agent session.

## Problem

Repository automation must make progress without silently bypassing review, duplicating
work, or creating work where there is nothing useful to do.

## Users

The repository owner supervises plans and pull requests; maintainers need predictable
automation state and planners need enough context to propose a correct change.

## Requirements

### Require explicit plan approval before implementation

An issue must not be implemented merely because a merge-related label was applied; a
human explicitly approves the plan before implementation starts.
**Why:** approval is the operator's chance to catch a bad plan before code is written.

### Approve a merge through one explicit control, not a free-text comment

Merge approval must be a deliberate, structured action — the dashboard's
Automerge control or Merge button, recorded on Claws' own record of the pull
request together with the approving identity — and never a comment whose text
an agent can reproduce. A forge-applied **Automerge** label is only a mirror of
that record and approves nothing (#3219).
**Why:** a free-text approval has no control surface — any actor that can comment
can produce one, and nothing records that it happened. A stored approval is
structured, auditable and revocable, there is exactly one of it to reason
about, and it names who gave it. See
[refinements/issue-flow.md](../refinements/issue-flow.md).

### Merge only on a reported CI result, not its absence

In a repository whose CI reports on pull requests, Claws — the auto-merger and
a session's `claws_merge_pr` alike — must not merge a pull request while its head
has no CI result. It waits until CI reports green. A pull request whose whole
diff is CI-exempt, or whose CI-exempt head sits on a commit CI already passed,
may still merge. A head CI never reports on must show as a visible hold with
its reason, not a silent merge. A repository with no PR-reporting CI opts out
with `mergeWithoutChecks` in `claws.json`
([jobs/auto-merger.md](../jobs/auto-merger.md#no-ci-result-on-the-head-statusnone)).
**Why:** a merge approval is not a test run. PR #105 merged on 2026-10-15 with
no CI on head `cdce0bad` — the reviewer had recorded "CI at review time: none" —
because the gate read an empty status set as passing, so unverified code
reached `main` and a release tag (#clw_01M50MY5NZYBNSG5X0FZYXVVGS).

### Keep label state aligned with the actual lifecycle

Issue and pull-request lifecycle state must communicate whether work awaits
requirements, planning, human input, review, CI, or merge, and must not strand
work after a docs-only follow-up. Claws' own store is the source of that state
— a field on Claws-tracked issues today, and a record per pull request once
[Hold pull request state in Claws' own store](#hold-pull-request-state-in-claws-own-store)
is built — and forge labels mirror it for anyone reading the forge; no
automated decision reads a label on a pull request. A merge hold on a pull
request is Claws' record alone, with no forge label: removing a label on the
forge never changes it and Claws never re-applies one, and an approved pull
request the record still blocks says so on the pull request.
An issue with a plan is in Planning only while a planner run is queued or
running for it; every other open issue sits where the board says who acts
next — plan review, Blocked with the reason a human is needed, or closed. A
**Claws Ignore** issue is shown as ignored, not as being planned. A planner no-code-change verdict
names its kind and ends the issue where the next actor is clear: closed for *already resolved* and
*transient*, in the Backlog for *operator task* and for a failed transfer to another repository —
never open with **Claws Ignore** in Planning (#clw_01M4RW0DDM0PSNEBDM5J11AKGE). A pull request that is merely
mentioned ("Part of …") without a phase marker never silently counts as covering a plan step;
an issue whose steps appear covered only that way goes to a human with the pull request named.
**Why:** operators use the dashboard and the labels as a view of reality and need
them to agree; a label any actor can apply is not a safe input to a decision. A
pull request that looked unblocked on the forge while its record still blocked the
merge sat unmerged with no visible reason (#clw_01M3M5ED6YNE8FTNE3QR8JR3XX). An ignored
issue must not look in progress, and a bare mention is not evidence that a step is done.

### Hold pull request state in Claws' own store

Every pull request Claws works has one record in its own store — the issue and
plan phase it implements, its stage (opened, CI failing, awaiting review,
addressing review, awaiting merge, problematic, merged, closed), the CI and mergeable state last observed, the review verdict of its
head, and the merge approval with who gave it and when. Agents transition the
record where they set labels today; the dispatcher refreshes what it observes;
the board, the auto-merger and the dashboard read the record. Forge labels are
written from it and never read. Whether an issue has an open pull request, and
at which stage, follows from the record rather than from a label on the issue.
Approved design: [refinements/issue-flow.md](../refinements/issue-flow.md).
**Why:** pull-request state is spread across six labels written by five agents,
the dashboard's view of it is an in-memory cache rebuilt each tick, and nothing
records who approved a merge; the issue side already made this move, and a
store the pipeline both writes and reads is what makes a board that disagrees
with the pipeline a writer's bug rather than a stale label.

### Keep an issue open until its plan's operator steps are done

When a plan ends with operator steps that are not a pull request — a migration's
import, secrets, deploy keys, re-pointed Flux, archived source — those steps are
tracked as a final step with no pull request: the issue stays open after its
last pull request merges, shown as awaiting an operator, until an allowed actor
marks the step done or closes the issue; once every pull request has merged
the issue is moved to Blocked with the step as the reason, and a step marked
done is acted on once the issue is out of Blocked. A pull request whose
plan step follows such an operator step holds its merge on that step, without
holding up the issue's other steps (see
[Hold only the pull request, never the issue, when it waits on an operator step](#hold-only-the-pull-request-never-the-issue-when-it-waits-on-an-operator-step)).
**Why:** four GitHub → Forgejo migrations closed as completed with their cutover
undone, and one cutover PR merged ahead of its operator steps left Flux failing
for ~17 hours (#clw_01M48WEHRHXGQGT558WG89NRY1); a note posted only after the
merge neither held the merge nor kept the issue open.

### Ask an operator only for work automation cannot do

A plan's operator steps name only work no automation in the pipeline can do: a
secret or credential, a physical or hardware action, a third-party account or
order, or an approval reserved for a human. They never name post-merge
verification, re-running or dispatching a CI workflow, or checking that a
deploy or published page is correct; the change's own workflows on main, or a
check added in the pull request, cover those, and main-branch failures are
raised automatically. A plan whose operator step is only verification or a CI
re-run is rejected when it is saved, and the planner is asked to drop it.
**Why:** #clw_01M4ZMWGS9VQAZQZD2F1FCP91G was parked in Blocked after its only
pull request (#48) merged, although pcb runs 619-622 on 08aaa1e had already
passed and uploaded the gerber zips the step asked a person to look for.

### Hold only the pull request, never the issue, when it waits on an operator step

A pending operator step before merge — the plan's or the implementer's — is a
merge hold on the pull request's record, shown as a warning on `/prs` and the
issue page, not a pull-request state: the pull request goes through CI-fix and
review with an ordinary stage that keeps following CI and review, and its issue
is not shown as stalled. The hold gates only that pull request's merge, even
under an issue-level Automerge or a per-PR merge approval; it never moves the
issue to Blocked, so Claws keeps implementing, reviewing and merging the
issue's other steps. Once the held pull request is otherwise ready to merge
(green CI, clean review of its head), Claws tells the operator once per pull
request and step text — one comment on the issue naming the pull request and
the step, and a **Manual action pending** entry in Needs-you. Only an explicit
per-PR signal lifts the hold: **Clear manual action** on `/prs` (which leaves
an audit comment on the pull request) or a session's
`claws_clear_pr_manual_action`; the merge then follows the usual rules. An
issue leaving Blocked for any reason never lifts a hold. Every other hold
either blocks the issue with a reason when Claws cannot move on — a review
escalated to a human, a CI run the forge refuses to re-run, a stacked pull
request — or clears itself when its condition resolves: a later clean or
advisory-only review round, CI going green, the pull request retargeted to the
default branch, the re-approval of a design change. No forge label mirrors a
hold.
**Why:** the old **Manual Action** pull-request state was set at creation while
CI-fix and review were still working the pull request, froze its stage, put
the issue in PR stalled and the nav count from the first minute, and was
re-applied when removed on the forge (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK). Parking
the issue instead then stalled every other step: on
#clw_01M34R5RDGCPK8WVC3MNG183NZ fleet-infra#196 (step 5, held for a cutover
that comes after steps 2 and 3) parked the issue and ready step 2 never
started, while unparking it to let step 2 run would have lifted #196's hold as
a side effect (#clw_01M5220Y7EWQG1X0H3Y3T45J81).

### Block the issue, not a pull request column, when its pull request needs a person

When an issue's pull request cannot move on without a person — its CI-fix
budget is exhausted (problematic) or CI is blocked (the Billing block) — Claws
moves the issue to Blocked with a reason that names the pull request, says why
and says what the operator can do. There is no board column for such a pull
request. Claws moves the issue out of Blocked on its own once the pull request
is back in the normal flow: unmarked problematic (on `/prs` or with
`claws_unmark_problematic`), CI unblocked, merged or closed. An issue Blocked
for any other reason — by the operator or another Claws step — is neither
re-parked nor released by this. Moving the issue out of Blocked by hand while
the pull request is still stuck re-parks it with the same reason, without a
second comment: unmark the pull request or fix CI instead. Parking the issue
does not stop CI-fix, review or the Problematic PR Diagnoser from working the
pull request, and a pull request with no linked issue stays visible as
problematic on `/prs` only. The nav counts the parked issue once in Issues,
through Blocked, and the pull request once in PRs.
**Why:** the board's PR stalled column meant the same thing as Blocked — a
human has to act — so operators had to look in two places for work waiting on
them (#clw_01M4TJEHAP19S2N3SE6EHE6VNA).

### Block the issue while its remaining steps wait on an open pull request

When the implementer finds no step it can start because every remaining step
waits on an open pull request to merge — for example a step committed onto
another issue's pull request, with an operator step depending on it — Claws
moves the issue to Blocked with a reason naming each pull request, such as
``Waiting on `St-John-Software/bonkus#3` to merge``, shown on the board card
and the issue page. It explains this on the issue once per set of pull
requests, however often the implementer runs. Once they have all merged, Claws
moves the issue out of Blocked by itself and continues with the next step,
or leaves it awaiting the operator when that step is theirs. If one closes
without merging, Claws keeps the issue Blocked with a reason telling the
operator to re-plan it or move it back to Approved. A pull request that
carries one of an issue's steps counts as that issue's open pull request on
the board, even when another issue opened it.
**Why:** the issue used to bounce back to Awaiting plan review, with no
explanation, every time Approved was applied, and its card hid the work in
flight (#clw_01M4XWHG3A2Q5Y06GN2SC7K06X).

### Let an operator close and relabel an issue whose repository is no longer configured

An issue whose repositories have all left the configuration can still be closed and
have its labels edited from the dashboard and the session tools, rather than lingering
on the board with no way to remove it.
**Why:** a native issue for a retired repository could not be closed and stayed in
Planning indefinitely (#clw_01M4RW0Y5BJXSD0HJM2R1BZF08).

### Leave alert-bridge issues to their bridge, and park a close that does not stick

Claws never closes an issue an alert bridge owns — labelled `alert` or
`grafana-alert`, or carrying the bridge's consolidated body or its
`Automatically managed by alert-issue-bridge` footer; the bridge closes it once
every alert section is resolved or tracked elsewhere. For both bridges —
production-infra's `alert-issue-bridge` and fleet-infra's
`grafana-github-alerts` — the issue is an inbox: new alerts arrive in it as
sections, and planning it triages each untriaged section rather than writing an
implementation plan. A section that needs no work is marked transient, with a
reason; one that needs work is moved into its own dedicated issue, filed with the
alert's stable `alert-<slug>` dedupe key, which the inbox depends on and which
its section shows as tracked. The triaged inbox is parked Blocked until a new
untriaged section arrives, and later firings of a tracked alert update its
dedicated issue instead of the inbox. A transient verdict stands until someone
deletes it from the body. The bridge's rewrites of such an open issue's body do not
re-plan it when they only change occurrence counters, timestamps, firing or
resolved status, firing instances, the Currently firing list or the triage rows;
a new untriaged alert section in a consolidated body, or a human edit to it, is
re-planned even when earlier steps have shipped. Edits to any other issue still
re-plan it. Each bridge finds, creates, rewrites, closes and reopens its issue
directly in the Claws tracker with a token scoped to its own repo's alert issue,
so no alert issue or alert-issue edit goes through Forgejo; the first lookup
after cutover continues the already-imported native issue and closes the
leftover forge copy rather than opening a second one. A plan whose every step is done, with no PR open, is not shown as
Awaiting merge. When every plan step has landed
and Claws's close is rejected or undone, the closing comment is posted at most
once per plan: the issue is moved to Blocked with a `## Needs a human` note, the
implementer is not run on it again, and once a human has acted Claws leaves it
where they put it. A re-plan starts afresh, so an issue that is reopened and
re-planned is closed again once its new plan lands.

**Why:** the Grafana alert issue #clw_01M48BJCC836TARVWTF7K39Z04 drew more than
60 identical "closing this issue" comments as the bridge kept it open, and each
bridge rewrite re-planned it, to plan version 104 on 2026-10-13. Firing-instance
and summed-total changes kept re-planning it to 132 plan versions in 9 days, each
finding no work left, while the board showed it Awaiting merge with no PR open
(#clw_01M4ZN75K7GK0G7AFZEHBNCWD5). While the bridges wrote their issue on Forgejo,
each alert issue existed twice, was imported up to 30 minutes late, and the
operator could not see its plan or board state (#clw_01M4ZWEP5X07N3KCAFV1BC27DK).
The same issue was still open on 2026-10-16, ten days after it opened on
2026-10-06, because 14 unrelated sections each had to resolve before it could
close; its single plan covered only the first alert, so the CI runner eviction
went unplanned for 9 occurrences while occurrence bumps re-planned it to no
effect (#clw_01M5370CR4B9KV8E33AC6EP4EQ).

### Capture requirements before planning

An issue can be filed as a short note. Before any plan is written, Claws reads
the repository and writes a requirements record — title, context, the ask
restated precisely, acceptance criteria, what is out of scope — as a versioned
record separate from the plan, which the person corrects by commenting and then
promotes; the planner plans against the approved version and no longer restates
the requirement itself. Every issue goes through this stage, bug or feature,
native or forge-filed; issues from automations and forge
imports promote themselves once the record exists; everything a human or a
headless agent files waits for a human, except that an interactive session which
supplies the requirements record when filing is approved on the operator's
behalf and goes straight to Planning. The New issue form's author chooses per
issue, and there is no per-repository override. A bug or
an alert issue promotes itself once the record exists whatever its source,
overriding the waiting default for those two shapes: the human's gate
for a bug or an alert is plan review, not this stage too. An issue that
already has a plan when this ships keeps its plan and skips the stage. A
native issue shows the record once, in its issue page's Requirements block,
never repeated as a comment in the discussion; a forge-filed issue also carries
it as a comment on the forge, the only place a forge reader sees it.
Approved design: [refinements/issue-flow.md](../refinements/issue-flow.md).
**Why:** a plan is only as good as the text it is planned from; the
investigation that makes a session-filed issue better than a hand-typed one is
worth a stage of its own, on a cheaper tier, with its own gate, and acceptance
criteria written before the code exists are what a review can check the code
against.

### Hold work in a backlog a human promotes, or until a date a human chose

An issue can be parked as "not now, but some day": it is off the board, every Claws job
skips it, and no automation moves it out again unless a human parked it until a date. The planner may send an
operator-task issue (or one whose automatic transfer failed) there, because a human has to act (#clw_01M4RW0DDM0PSNEBDM5J11AKGE). Only a human promotes it back to
Drafting or Requirements review (or to Planning, when it already has a plan or approved requirements), after which
it is planned as normal (see [issue-tracker.md#backlog](../issue-tracker.md#backlog)).
An operator (or a session) may instead park a native issue until a calendar day. When the day
passes, Claws takes it out of the Backlog to where a Promote would land it, verifies an existing
plan against the current state of the repositories, merged PRs and comments — keeping it
unchanged when it still fits, revising it with the earlier version under Previous plans when it
does not — and plans an issue that had none. The requirements record and its approval are
untouched, the operator is told once (an issue comment and a Slack line saying whether the plan
was kept or revised) and reviews it through the normal plan-review gate. Moving the issue out
before the day clears the date (#clw_01M52A1VC256AJHN5DYMX64T5Y; see
[issue-tracker.md#parking-until-a-date](../issue-tracker.md#parking-until-a-date)).
**Why:** without it the board doubles as the backlog. Every idea is auto-planned within
minutes and piles up in Awaiting plan review, which hides the real to-do list. Work that
must wait for wall-clock time — a week of metrics before right-sizing a deployment — otherwise
lives only in an operator's memory: Claws either attempts it too early or never returns to it
(#clw_01M52A1VC256AJHN5DYMX64T5Y).

### Do not create work for a no-action outcome

Automation must filter a verified no-op, duplicate, blocked, or wrongly routed outcome
before creating unnecessary follow-up work, while retaining an actionable explanation.
A companion issue a headless agent files for work an open issue already covers is such
a duplicate: Claws returns the open issue and notes the extra caller on it instead.
The same applies to issues Claws files or imports itself (#clw_01M4RW0TECEKTFT6ZY6GS18DH3):
a reminder issue Claws files itself is parked in the Backlog and never planned;
a dependency bot's tracking issue (Renovate's Dependency Dashboard) is never imported;
a CI-runner issue duplicating a `main-build-monitor` failure is closed on the forge
instead of imported; and an `upstream-watcher` alert that a watch-file change fixes is
planned normally rather than filed already ignored.
**Why:** a backlog full of un-actionable issues hides work that needs attention.

### Route misplaced work to the repository that owns it

When an issue clearly belongs to another managed repository, Claws must support a safe
same-owner transfer without making the transferred issue look already planned.
**Why:** users should not have to recreate a correctly diagnosed report by hand.

### Keep repository-specific policy with the repository

Settled per-repository automation choices belong in the repository configuration; host
configuration is an operator override only, with clear precedence and fail-open reads.
A repository's root instructions file is `AGENTS.md` and its role documents are
`.agents/<role>.md`, so one canonical location holds each, whatever agent reads them.
**Why:** onboarding and review of repository policy should happen in that repository.

### Preserve a pull request for every completed bump

An automation-created update branch is not complete until the corresponding pull request
exists, and a transient create failure must be retried without losing the update.
**Why:** an unreviewable branch silently drops the release or remediation it represents.

### Process third-party dependency updates at any hour

Third-party dependency-update pull requests (Renovate, Dependabot) receive review, CI-fix,
review-addressing and merge work at every time of day; Claws never defers them by the clock
and shows each one's real blocker. The update tools are scheduled to open them in the
evening, 19:00 Europe/London, so bot PRs do not occupy work workers during office hours, and
the dependency-config scanner flags any schedule inside 08:00–18:00 Europe/London. If daytime
bot PRs starve the planner again, the remedy is scheduling and the stage-ranked claim order,
not a time gate.
**Why:** on 2026-09-24 bot-PR work held both work workers from 13:54 to 16:14 and no planner
run started, which led to an in-Claws out-of-hours window; on 2026-10-05 that window hid the
real blocker on 10 of 16 waiting PRs, and Dependabot PRs opened by day sat idle for 12 hours
with green CI (issue clw_01M46Y7NQYCPB52RV73MYRMXCD).

### Spend no agent work on a pull request that waits only for a human

A pull request that already carries a completed, up-to-date review and is waiting only
on a human to merge or comment must not receive a fresh CI-fixer or reviewer-agent run
merely because it remains open or because CI reruns for a reason unrelated to a new
commit on it. A pull request that genuinely needs attention — a human requests a change,
new review feedback arrives, or the pull request's own commits break CI — is unaffected.
**Why:** a pull request that is reviewed, green at review time, and waiting on the owner
must not consume agent runs or CI reruns merely by staying open (issue
clw_01M3F9340HHVH185YR16PXVKWK).

### Treat a CI run that produced no logs as a runner problem, not a code failure

A CI-fix attempt that could read no failure log and only re-ran the workflow changed
nothing in the pull request, so it must not count towards the fix-attempt budget that
marks a pull request `Claws Problematic`; such attempts are bounded separately. A job
that finished with zero steps must be named, with the runner it was assigned to, in the
task history, the Problematic reason and the diagnosis report, which must say the job
produced no logs and point at the runner rather than the pull request. A run that mixes
a stepless job with a genuine failure must still yield the genuine failure's log.
**Why:** on fleet-infra#1699 on 2026-10-03 job `migration-exec-secrets` hung with zero
steps on runner `nas`; two re-run-only attempts tripped `Claws Problematic` on a PR whose
only real failure was readable in another job, and the diagnoser reported only "no log"
(issue clw_01M460W3VM5QTQ4VF3067D8KF1).

### Count only CI-fix attempts that pushed a commit or gave up with a reason

A CI-fix run that pushes no commit and states no reason for giving up must not count
towards the fix-attempt cap that marks a pull request `Claws Problematic`; only runs that
push a commit, or explicitly give up with a stated reason, count. While any check on the
pull request's head is still running alongside a failed check, the fixer must wait for
the running checks to finish before attempting a fix, and the wait must consume no
attempts. The `Claws Problematic` comment for an exceeded cap must state how many
attempts actually pushed a commit.
**Why:** on electronics#12 on 2026-10-06 five 30-second no-op runs, made while
`pcb-busy-board` was still building the bundle the failing `sim-busy-board / check` needed
(19:40–20:12 BST), marked the PR Problematic though no fix was ever tried (issue
clw_01M49A6JGND6A965TKMH1F5SSC).

### Merge routine dependency updates without a dashboard approval

A non-major Renovate update opened by a trusted Renovate identity — the Renovate app, the
Forgejo `renovate` account, or an allowed human actor's PAT — merges at any hour
without a dashboard approval once CI is green and Claws' review of its current head is
clean, as Dependabot's updates already do. A major update, an infrastructure path or a
recorded merge hold still waits for a human, and the forge `Automerge` label is never read as
approval. The one infrastructure exception is a Dependabot or trusted non-major Renovate PR
confined to provider pins (`versions.tf`, `.terraform.lock.hcl`) whose repo-run Tofu Plan
for the exact head succeeded and shows no changes; any change, or a plan that cannot be
verified for that head, still waits for a human. The dashboard marks an otherwise-mergeable PR that lacks approval as awaiting
approval, with the reason it is held.
**Why:** after #3399 stopped reading forge labels, every fleet-infra Renovate PR sat
unmerged with clean CI and review; routine bumps need no human judgement, majors and infra do — except a provider bump whose
verified plan is a no-op, which cannot change infrastructure (bstjohn-blog #751, #755).

### Open one Renovate pull request per update and run no Dependency Dashboard

The unit of dependency work Claws manages is the Renovate pull request. Every available update, once past its minimum release age, gets its own pull request on the next weekly run; no managed repository keeps a Dependency Dashboard issue, and repository configs must not defer updates onto one.
**Why:** a dashboard is a single rollup issue Claws cannot manage, and importing one round-trips because Renovate re-creates it. Operator decision 2026-10-16 (#clw_01M521N4S7CFHRJ6VQMHC52CFB), superseding turning the dashboard on per repository.

### Classify Renovate updates by version change when the Update column is absent

When a Renovate PR body has no Update column, major versus non-major is decided from each
row's from and to versions: a changed leading major number is major, anything else (including
a 0.x minor) is non-major, and only a body with neither column stays unknown and held.
**Why:** a Renovate default change dropped the Update column and every non-major PR across the
Forgejo repos sat Ready with green CI until merged by hand (#clw_01M4RJBA47JM8XQA7AEM3B6M0F).

### Merge image bumps that only touch the registry tag allowlist

A Claws image-bump pull request in `fleet-infra`, or an own-app auto-bump pull request in
`production-infra`, is still a pure bump when, besides
its image-pin rewrites (including an environment variable re-pinned from one tag or digest of the same image to another), it changes the registry's tag allowlist only by adding the bumped-to tag
or by swapping the outgoing tag of the same image for it, or by removing only the outgoing tag(s) when the bumped-to tag is already listed because another app pins it, even when the swap removes an entry from
the middle of the list and moves the trailing comma onto the previous last entry. Removing an unrelated entry, adding
more than one, or naming a tag no manifest bumps to still blocks it, so no unreviewed
configuration change rides along. Registry-host migrations stay a human merge: a stored
dashboard merge approval is that human merge, after which the PR merges once its current
head has a clean Claws review and green checks, and until then the PR and `/prs` show that
it is held because its diff is not an image-pin-only bump (#clw_01M4RV5WKJT5XQN89BKMN7X8RH).
**Why:** bumps that rewrite or append the allowlist stopped merging on their own, so production
sat on an old release while merged fixes waited (#clw_01M4ESXSYCQ1HBVT3JV84S23VB, #clw_01M4GRT6MZFPH2CMDKYJ33VW7D, #clw_01M4RJBRBXFFMCMXABNBB3T7PD); and three registry-host
bumps during the GHCR migration were held silently, one despite an approval, until merged by hand.
**Why:** production-infra's namey bumps #34, #36, #41 and #43 also edit the prod registry allowlist,
so each sat green, cleanly reviewed and Ready until it was merged by hand or superseded, with
nothing in the job logs saying why (#clw_01M4TK4C1E6VHMC09T13HDCBHJ).
**Why:** production-infra #86 (namey to v2026-10-16.3, shared with bonkus #80) was held for a
manual approval despite green CI and a clean review, because its only allowlist change was
removing the outgoing tag (#clw_01M5359MZ63V20XB4T4BC3M1W2).

### Track work in Claws' own issue stream

Claws must be able to hold a work item in its own tracker — one global stream,
each item tagged with the repositories it concerns, which may be several or none
yet — and plan, implement, review
and close it through exactly the same lifecycle as a forge issue, with no
separate pipeline and no per-job special case. An issue filed on a forge also
has a record in that tracker, kept in step with it and invisible to the
operator, so tracker-side data applies to every issue Claws works and not only
to the natively filed ones. Once new issues are filed in Claws' own tracker,
open forge issues — including ones marked to be ignored, which stay ignored —
are moved into it continuously without the operator triggering anything, except
while work on them is in flight. Where moving is enabled, a forge issue is moved
within one dispatch cycle of Claws first seeing it, and no agent runs on,
comments on or relabels it before then; the board shows it as waiting for
import, with no plan gate, and says why when an exclusion holds it back. A native issue carries its own files — images,
archives, arbitrary binaries — and agents receive them the same way they receive
a forge issue's attachments. An item concerning several repositories gets one
plan, which names the PRs it needs in each of them and which of those PRs
depend on which, with no companion issues, and PRs that depend on nothing
still unmerged proceed in parallel;
an item with no repository yet can be filed and discussed but is not planned
until it has one. Wherever issues are viewed by repository, an item is shown
under every repository it names, with the one owning planning marked. Sessions and headless agents file and comment on items
directly through the tracker's write tools rather than through the forge, so
a session-filed item never takes the indirect forge-then-import route a
human's own forge issue does. A forge original that is reopened or edited after
its move — by anyone, including a bot — updates the tracker issue, reopening it
if needed so the new signal is planned there, rather than becoming separate
work. Once an issue is imported, every dashboard link
to it — under either its old forge number or its new tracker id — opens the
Claws page; only the issue page itself links back to the forge original.
**Why:** the forge is one of several places work arrives from, and the lifecycle,
not the host, is what the operator supervises; a change that spans repositories
is still one piece of work to the operator. Work done on a forge copy about to be
closed as moved left the operator a plan gate with nothing to review
(#clw_01M52GPG0E9DP8RQKW6ABH0X7R).

### Hold dependent work until its dependency closes, then resume it without a human

An issue in Claws' own tracker can record typed relationships to other tracker
issues — depends on, blocks, relates to — visible from both ends and editable
by the operator and by agents. Work that depends on a still-open issue is never
implemented; when its last open dependency closes, however it closed, the
dependent issue leaves Blocked on its own, re-planned or marked ready as its
plan warrants, with a comment naming what cleared. The planner sees an issue's
relationships and records a dependency it discovers as one rather than only in
prose.
**Why:** a dependency that lives only in a plan comment is never re-checked, so
an issue parked on work that has since shipped sits Blocked until a human
notices; the tracker is the one place both issues are, so it is where the
relationship belongs. Extends
[Track work in Claws' own issue stream](#track-work-in-claws-own-issue-stream).

### Make generated plans durable and reviewable

Plans and other text intended for onward posting must be collected as complete authored
documents, not accidentally replaced by later process output. A plan's sections must be
written so the operator can find its decisions and steps at a quick read (lists and short
items, not unbroken prose).
**Why:** operators approve the document they see, so it must be the agent's intended plan, and the approval gate is only as strong as the plan's readability.

### Carry design-changing feedback through to a revised plan and requirements

Feedback on an issue with an open PR must be classified as answered, a plan amendment or
a design change. A question gets only a reply. An amendment edits the plan in place, keeps
the open PR, and names which open PR, if any, must change to match. A design change — PRs
added, removed, reordered or redirected, or the requirements contradicted — must store a
new, unapproved requirements version and a plan marked pending re-approval, hold every
open PR it supersedes from merging, and name each with its fate (closed, reworked or
kept). While it waits the issue sits in a column that says it needs a decision. No PR is
closed or reworked until the operator promotes the new requirements or applies `Refined`;
then the superseded PRs are closed or re-targeted, no stale `(N/M)` marker counts as
covering a step of the new plan, and the normal implement flow resumes.
**Why:** a design change accepted only in a reply left the plan and requirements at their
old versions and the issue stuck in Awaiting merge, so the operator had to close PRs and
move columns by hand — and an old PR's phase marker could silently count as covering a
step of the new plan.

### Verify who approved, not just that an approval exists

A human-in-the-loop gate must check the approving identity — an allowed actor that is
not Claws itself — not merely that an approval signal is present.
**Why:** Claws' own forge accounts can emit every signal a human can, so an approval
an agent can produce for itself is not supervision.

### Attribute review feedback by author identity, not by content

Whether a comment counts as human direction must follow from the login that posted it.
Content written by Claws' own account is never authoritative human feedback, however it
is marked. A forge CI account (`github-actions[bot]`, `forgejo-actions`) is never human
feedback either (#clw_01M4B5GZK2CC3F5MKE4W6P2XZV).
**Why:** an agent holding the forge token chooses what it writes but not who it is, so a
body marker is not an attribution check.

### Treat forge CI-runner issues as work

An issue filed by the forge's CI runner — `github-actions[bot]` on GitHub, `forgejo-actions`
on a Forgejo repo — is dispatched like an operator's issue, without being listed in
`allowedActors`. Those identities never satisfy a human-approval gate.
**Why:** runner-filed issues are CI-failure notices, not unvetted third-party input, but the
runner account must never be able to approve work.

### Treat Claws' own companion issues as work

An issue filed in a managed repo by any of Claws' own forge accounts, including the
least-privilege Forgejo read/issue account, is dispatched like an operator's issue. Those
accounts still never satisfy a human-approval gate.
**Why:** an agent working one issue may need to file a companion issue on another managed
repo, and that issue is Claws-authored work, not an unvetted third party's — but the
account that files it must not be able to approve its own or anyone else's work.

### Keep a plan's preview evidence in step with the plan

A preview a planner produced for plan approval (rendered candidate output on a disposable
preview PR or branch) must match the plan being approved, must be visible from the issue, and
must be retired once the plan is decided — approved (`Refined`) or closed. A PR-less
preview (a bare `claws/preview-issue-<ref>` branch) must be found and mirrored the same
way whether the repository is hosted on GitHub or Forgejo, and every managed repository
defaults to looking for its summary at the fleet pages host's issue-preview path; a
repository that sets its own `issuePreviewSummaryUrl` keeps that value
(#clw_01M3J52H0H9WSH3GTSY87ZY351, 2026-09-28).
**Why:** a maintainer approving a plan against renders of an earlier revision approves the
wrong thing, and a preview nobody retires keeps its artifacts and its PR or branch around
until someone closes or deletes it by hand. A preview that only works on one forge, or
only for a repository that configured its own bucket, silently leaves the rest of the
fleet without evidence.

### Make per-phase model selection visible and editable

For every issue, the provider and model tier each pipeline phase will run on — requirements,
planning, plan refinement, implementation, review, CI fixing and review addressing — must be visible
in one place, together with which input chose it, and an operator must be able to change
any phase from the dashboard. The planner may suggest a later-phase model but may never
spend the top tier outside planning on its own.
**Why:** the model used to be decided by five unrelated mechanisms (plan prose, PR markers,
a complexity classifier, a fleet default and provider labels), so an operator could neither
see which one won nor override it without editing text an agent had written.

### Plan an incident alert ahead of ordinary queued work

An issue carrying an incident label (the built-in `grafana-alert`, or any label a
repository declares under `incidentLabels` in its `claws.json`) must be planned before any
non-Priority queued work, and must not wait for a free worker: a reserved priority-only
worker picks it up within one dispatcher cycle of the issue being opened.
**Why:** an outage's cost is measured from detection to a plan somebody can act on, and the
queue's merge-first ordering, right for routine work, left fleet-infra#1596 waiting 55
minutes behind PR reviews on 2026-09-24.

### Document cross-repo deployment links only from stated evidence

Each managed app's docs must name and link the repos and files that deploy, configure or
provision it, and each such repo must link back to every app it serves. Every link must
trace to a named evidence source with a stated authority order, point at the forge that
actually hosts the target, be kept current on normal runs, and be omitted — with a note
saying none was found — when no evidence exists. A dedicated fleet-map docs repo stays an
option, not a requirement. An app's infrastructure prerequisites held in another repo (the
blog repo, for example) count as deployment relationships once evidenced.
**Why:** guessed links rot or point at stale GitHub mirrors, so readers and agents could not
trust them and had to search for where an app is deployed instead.

## Non-goals & rejected ideas

- Do not use GitHub issues as a substitute for higher-level, multi-issue goals.
- Do not automatically merge dependency updates merely because their changes are small.
- Do not close a forge issue again after a human reopened it following its closing pull request's merge; park it for a human instead.

## Open questions

- Whether a runtime-configurable agent SDK should replace CLI-driven agents remains approved but unbuilt.
