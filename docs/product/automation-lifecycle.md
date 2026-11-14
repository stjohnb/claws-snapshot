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

An issue is implemented only once it is approved through Plan. Its approval is one stored value
on the issue — how far along Requirements → Plan → Merge it is approved, with who set it and when —
never a label, and a merge approval alone never implies a plan approval. Approving through Plan
before a plan exists pre-approves the plan Claws writes; the planner withdraws that pre-approval
(lowers it to Requirements, saying why) when its step-back review says `reconsider` or when human
feedback newer than the approval re-plans the issue, so the revised plan stops for review. Only an
unattended filer of routine work (a CI failure unrelated to the PR, a routine dependency alert) files
an issue pre-approved without a human; the planner's withdrawal applies to it too. A multi-PR plan is
approved once and implemented step by step without re-approval. Moving an issue out of Blocked, by
hand or by a dependency release, never changes its approval; only the planner's withdrawal or an
explicit move to Planning or Awaiting plan review lowers it.
**Why:** approval is the operator's chance to catch a bad plan before code is written. Five labels
used to carry it (`Refined`, `Ready`, `Ship`, `Claws Auto-Refine`, `Automerge`), each with its own
writers and readers, so the board, the pipeline and a session could each read a different answer, and
a multi-PR issue flipped `Refined` off and on at every step (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F).

### Approve a merge through one explicit control, not a free-text comment

Merge approval must be a deliberate, structured action — approving the issue through Merge
(the approval track's Merge gate, or an interactive session's `claws_set_issue_approval`), a
single pull request's approval (`/prs`, `claws_approve_pr_merge`), or the Merge button — recorded
on Claws' own record of each pull request together with the approving identity, and never a
comment whose text an agent can reproduce. An issue approved through Merge records it on every
open pull request and on each one Claws opens for it later; lowering the issue's approval below
Merge withdraws it from all of them. Claws writes no label for it, and the retired forge
**Automerge** label approves nothing (#3219, #clw_01M5VW14RKAAGS6VZ5PCKQXB9F): the approval is
visible on the PR's dashboard row and through `claws_open_prs`.
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

### Merge past a gate only in the Forgejo UI

When an outage keeps a pull request's CI or Claws review gate from passing, the
operator bypasses the gate by merging the pull request in the Forgejo UI. Claws
itself never merges past a gate: no dashboard page, session tool, agent token or
the auto-merger can, and a session's CI or review merge refusal tells the
operator to merge in the Forgejo UI instead. A pull request merged in the
Forgejo UI must advance its issue's plan exactly like one Claws merged: the step
is marked done and the next step dispatched, a completed plan closes (or the
operator is told a manual step is next), and the pull request's holds and
"Merge blocked" status are cleared.
**Why:** the dashboard emergency-merge page failed on its first real use on
2026-11-13 — its merge button did nothing — while the Forgejo UI merge of the
same pull request worked at once, so the operator wanted the page removed
rather than fixed (#clw_01M7AB0Y52QAYR0W1XRVY3BVEV).

### Hold a dependent step's merge while an earlier step's deploy is red

A plan step that depends on an earlier, merged step must not auto-merge while
the earlier step's repository has a declared deploy workflow
(`deployWorkflows` in `claws.json`) whose latest run on the default branch
since that merge failed, or is still running. The hold shows on the pull
request and the issue with the failed run, never parks the issue, and lifts by
itself once a later run of that workflow passes
([jobs/auto-merger.md](../jobs/auto-merger.md#red-deploy-on-an-earlier-step)).
**Why:** readiness only checked that a dependency had merged.
production-infra#641, step 2 of #clw_01M6NVFJQH6227AXV2B7SP9CVA, merged on
2026-11-05 while the `tofu-apply.yml` run after step 1 (production-infra#633)
was red, so prod Flux switched to a bucket that did not exist and every prod
Kustomization went NotReady (#clw_01M6RPD77S4VCG7068KVFN4GEF).

### Keep label state aligned with the actual lifecycle

Issue and pull-request lifecycle state must communicate whether work awaits
requirements, planning, human input, review, CI, or merge, and must not strand
work after a docs-only follow-up. Claws' own store is the source of that state
— a field on Claws-tracked issues today, and a record per pull request once
[Hold pull request state in Claws' own store](#hold-pull-request-state-in-claws-own-store)
is built — and forge labels mirror it for anyone reading the forge; no
automated decision reads a label on a pull request. An issue's approval is
Claws' stored record too, never a label: the retired gate labels (`Refined`,
`Ready`, `Ship`, `Claws Auto-Refine`, `Automerge`) are neither written nor read,
and the board derives Awaiting plan review or Approved from the stored stage
and the stored approval together (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F). A merge hold on a pull
request is Claws' record alone, with no forge label: removing a label on the
forge never changes it and Claws never re-applies one, and an approved pull
request the record still blocks says so on the pull request.
An issue with a plan is in Planning only while a planner run is queued or
running for it; every other open issue sits where the board says who acts
next — plan review, Blocked with the reason a human is needed, or closed. A
parked issue is shown in Blocked or the Backlog, not as being planned. A planner no-code-change verdict
names its kind and ends the issue where the next actor is clear: closed for *already resolved* and
*transient*, Blocked (the operator steps as the reason, with a `## Needs a human` note) for
*operator task* —
never left open in Planning (#clw_01M4RW0DDM0PSNEBDM5J11AKGE). A pull request that is merely
mentioned ("Part of …") without a phase marker never silently counts as covering a plan step;
an issue whose steps appear covered only that way goes to a human with the pull request named.
**Why:** operators use the dashboard and the labels as a view of reality and need
them to agree; a label any actor can apply is not a safe input to a decision. A
pull request that looked unblocked on the forge while its record still blocked the
merge sat unmerged with no visible reason (#clw_01M3M5ED6YNE8FTNE3QR8JR3XX). An ignored
issue must not look in progress, and a bare mention is not evidence that a step is done.
An operator task, which may be security-relevant, dropped out of sight in the Backlog (a leaked
PAT revocation, #clw_01M5J5RWG34GHZWFPV03ZWCAWM), and only a human should put an issue there
(#clw_01M5MNHRYQP0X2FRNS72EVBST6).

### Hold pull request state in Claws' own store

Every pull request Claws works has one record in its own store — the issue and
plan phase it implements, its stage (opened, CI failing, awaiting review,
addressing review, awaiting merge, problematic, merged, closed), the CI and mergeable state last observed, the review verdict of its
head, and the merge approval with who gave it and when. Agents transition the
record where they set labels today; the dispatcher refreshes what it observes;
the board, the auto-merger and the dashboard read the record. Forge labels are
written from it and never read. Whether an issue has an open pull request, and
at which stage, follows from the record rather than from a label on the issue.
Every review-cycle hand-off — the review verdict and the head it covers, the
next review round, escalation, the findings handed to the addresser, and
whether the addresser addressed, rebutted or advisory-fixed a round — comes from
the recorded review rounds (`pr_reviews`), never from the review comment's text,
which is output for humans only.
Approved design: [refinements/issue-flow.md](../refinements/issue-flow.md).
**Why:** pull-request state is spread across six labels written by five agents,
the dashboard's view of it is an in-memory cache rebuilt each tick, and nothing
records who approved a merge; the issue side already made this move, and a
store the pipeline both writes and reads is what makes a board that disagrees
with the pipeline a writer's bug rather than a stale label. A review that
merely quotes a marker such as `review-result: clean` or `<details>` once
flipped a pull request's status (#416, #427), so the comment can no longer
decide anything.

### Keep an issue open until its plan's operator steps are done

When a plan has operator steps that are not a pull request — a migration's
import, secrets, deploy keys, re-pointed Flux, archived source — those steps are
tracked as one step with no pull request: the issue stays open after its
last pull request merges, shown as awaiting an operator, until an allowed actor
marks the step done or closes the issue. The step comes last unless a pull
request needs its output (a URL, a secret name, an imported repo); then it comes
just before the first such pull request, which is not started until the step is
marked done. Once every step the operator step follows has landed, the issue is
moved to Blocked with the step as the reason, and a step marked
done is acted on once the issue is out of Blocked. A pull request whose
plan step follows such an operator step holds its merge on that step, without
holding up the issue's other steps (see
[Hold only the pull request, never the issue, when it waits on an operator step](#hold-only-the-pull-request-never-the-issue-when-it-waits-on-an-operator-step)).
A re-plan keeps an operator step already marked done at its recorded position,
whatever the planner flags.
**Why:** four GitHub → Forgejo migrations closed as completed with their cutover
undone, and one cutover PR merged ahead of its operator steps left Flux failing
for ~17 hours (#clw_01M48WEHRHXGQGT558WG89NRY1); a note posted only after the
merge neither held the merge nor kept the issue open. An operator step that
could only come last let Claws dispatch PR 2 of #clw_01M63J1CHRSJFSKRWY4JYC4G5S
before the operator had posted the URL it needed. Two refine runs of
#clw_01M6P1R033DFKKMJTX38TJHTPW had every save rejected because a done step had
to be re-declared through a flag.

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
under an issue approved through Merge or a per-PR merge approval; it never moves the
issue to Blocked, so Claws keeps implementing, reviewing and merging the
issue's other steps. Once the held pull request is otherwise ready to merge
(green CI, clean review of its head), Claws tells the operator once per pull
request and step text — one comment on the issue naming the pull request and
the step, and a **Manual action pending** entry in Needs-you. Only an explicit
per-PR signal lifts the hold: **Clear manual action** on `/prs` (which leaves
an audit comment on the pull request) or a session's
`claws_clear_pr_manual_action`; the merge then follows the usual rules. An
issue leaving Blocked for any reason never lifts a hold. The one exception
is an operator step CI cannot pass without: when the held pull request's CI is
failing and the CI fixer has given up on its head, and no other step of the
issue is ready or in flight, Claws moves the issue to Blocked with a reason
naming the pull request and the step, and moves it out on its own once the
hold is cleared, CI stops failing, or the pull request merges or closes; the
hold itself is never lifted by this, and moving the issue out of Blocked by
hand re-parks it. With another step ready or in flight, the issue gets one
comment instead and keeps working that step. Every other hold
either blocks the issue with a reason when Claws cannot move on — a review
escalated to a human, a CI run the forge refuses to re-run, a stacked pull
request — or clears itself when its condition resolves: a later clean or
advisory-only review round, CI going green, the pull request retargeted to the
default branch, the re-approval of a design change. No forge label mirrors a
hold. The plan places its operator step where the step's prerequisites put
it — after a named pull request, before the pull requests that need its
output — rather than always last, so the stored steps match the plan's own
order.
**Why:** the old **Manual Action** pull-request state was set at creation while
CI-fix and review were still working the pull request, froze its stage, put
the issue in PR stalled and the nav count from the first minute, and was
re-applied when removed on the forge (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK). Parking
the issue instead then stalled every other step: on
#clw_01M34R5RDGCPK8WVC3MNG183NZ fleet-infra#196 (step 5, held for a cutover
that comes after steps 2 and 3) parked the issue and ready step 2 never
started, while unparking it to let step 2 run would have lifted #196's hold as
a side effect (#clw_01M5220Y7EWQG1X0H3Y3T45J81). When the step is a
prerequisite for CI the PR is never otherwise ready, so the operator was never
told: namey#111's own OpenTofu stack creates the roles its plan job assumes,
its CI fixer gave up on the head, and the issue sat in In progress, out of
Blocked and Needs-you, for 16+ hours with every later step waiting on it
(#clw_01M61A554ED0300Q1J0WKZJPSG). An operator step whose secret a later pull
request's build reads was stored last, after that pull request, contradicting
the plan text that ordered it between the two
(#clw_01M70G1VXV5MS5GAX1MQSC45TK).

### Never hold a pull request on a step that waits for it

A merge hold on pull request N never names work that a later step depending on
N delivers. Claws drops such a hold from the implementer — before or after
merge — and notes the sequence in the pull request body instead, and refuses a
planner's plan-level hold of the same shape when the plan is saved.
**Why:** on #clw_01M709CNKCK3K381M7JKQG9S4H the implementer held fleet-infra#1034
(step 1) until the home-assistant-config change was merged and flashed — but
that change was step 2, which could not start until #1034 merged, so both sat
deadlocked until an interactive session cleared the hold by hand
(#clw_01M70G1VXV5MS5GAX1MQSC45TK).

### Stop flagging a pull request for an operator step already recorded done

Once the issue records a plan's operator step as done with a `claws-phase-done` claim (typed, posted by the board and issue page's **Mark step N done** button or an interactive session's `claws_mark_phase_done`, or carried by an interactive session's informational note — a headless agent's note never counts), its
pull requests no longer show "Operator step pending", drop out of Needs-you's Manual action
pending list, and stop asking for merge confirmation because of that step. A pull request's own
recorded merge hold still shows. If the claims cannot be read, the step counts as pending. A
claim on an operator step counts even before the steps it follows have landed, and the phases
tool says per step whether it is claimed and what it still waits on.
**Why:** a retired step kept every PR in a 21-step series flagged as needing the operator
(#clw_01M5HQB12F3AQTWTB5AWQSWEPW). A claim posted as a session note was silently ignored, because
every Claws-marked comment was skipped as a claim, and nothing said why
(#clw_01M70G1VXV5MS5GAX1MQSC45TK). A headless agent's note is excluded because every note posts
as Claws' own login, and an agent steered by an issue body or diff must not retire a step; only
a note posted through the session's own token-checked route carries the session line that
makes its claim count.

### Block the issue, not a pull request column, when its pull request needs a person

When an issue's pull request cannot move on without a person — its CI-fix
budget is exhausted (problematic), CI is blocked (the Billing block), or CI is
failing on a head the CI fixer gave up on while the pull request waits on an
operator step and nothing else on the issue is ready or in flight — Claws
moves the issue to Blocked with a reason that names the pull request, says why
and says what the operator can do. There is no board column for such a pull
request. Claws moves the issue out of Blocked on its own once the pull request
is back in the normal flow: unmarked problematic (on `/prs` or with
`claws_unmark_problematic`), CI unblocked, its operator-step hold cleared or
CI no longer failing, merged or closed. An issue Blocked
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
and the issue page. The board shows it in Queued rather than Blocked, since
it needs no one. It explains this on the issue once per set of pull
requests, however often the implementer runs. Once they have all merged, Claws
moves the issue out of Blocked by itself and continues with the next step,
or leaves it awaiting the operator when that step is theirs. If one closes
without merging, Claws moves the issue to Blocked with a reason telling the
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

Claws never closes an issue an alert bridge owned — labelled `alert` or
`grafana-alert`, or carrying a bridge's consolidated body or its
`Automatically managed by alert-issue-bridge` footer. Such legacy inboxes no
longer take new alerts: Claws' Alertmanager poller files one issue per alert
group, found by its exact dedupe key, and that issue is planned like any other.
A legacy inbox is never a dedicated alert issue: it is never a dedupe match for
a filed issue and never the issue an alert group routes to. A recurrence on an
alert issue with no tracking block dates First seen from the issue's creation
and counts at least two occurrences. Rewrites of a legacy consolidated body do
not re-plan it when they only change occurrence counters, timestamps, firing or
resolved status, firing instances, the Currently firing list or the triage rows;
a human edit to it is re-planned even when earlier steps have shipped. Edits to
any other issue still re-plan it. No alert issue or alert-issue edit goes
through Forgejo. A plan whose every step is done, with no PR open, is not shown as
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
effect (#clw_01M5370CR4B9KV8E33AC6EP4EQ). Inbox #clw_01M57YH7V136WTDBE5RRMVMFAE
acquired an `alert-` key through a similarity match and sat Blocked for two days
after its alerts resolved, because the bridge was told it was tracked elsewhere
(#clw_01M5D4GX95DPEV43KN75CE9T8C).

### Capture requirements before planning only for an issue a human files by hand

An issue a human files by hand — on the dashboard's New issue form, by message, or on a
forge — can be a short note. Before any plan is written for it, Claws reads the repository
and writes a requirements record — title, context, the problem and the outcome it needs,
outcome-level acceptance criteria, what is out of scope — as a versioned record separate
from the plan, which the person corrects by commenting and then promotes. An issue filed on
the New issue form always gets a record and always waits in Requirements review for the
person to promote it, a bug included; there is no per-repository override. A forge-filed
issue's record promotes itself once it exists, and a bug or an alert issue's record
promotes itself whatever its source (a form-filed issue excepted): the human's gate for
those is plan review, not this stage too. A bug's record is just the symptom, the expected
behaviour (citing the product requirement it breaks) and the requirement to find and fix the
root cause and record it on the issue; it never guesses at causes or restates guarantees the
fix leaves untouched.

An issue filed by an automation (an alert, a scanner, a monitor, the friction
retrospective), by a headless agent or by an interactive session skips the stage: no
record is written, and it goes straight to Planning, where the planner plans from its
title, body and comments (#clw_01M640XY068DPVY2HQB64J33PE). If its filer held it, or a
human sent it back to requirements, it waits in Requirements review on its own text —
still with no record — until the operator promotes it from the board card or the issue
page, or leaves feedback; it never parks in Drafting, which means only that Claws is
writing or revising requirements (#clw_01M6P1JF7XH07J2VKCGSZ5NVVB).

Where a record exists, the planner reads it as the statement of the problem, not as a
constraint on the solution: it may plan a different approach than the record implies,
and when it does it says so plainly in the plan, so the operator sees the departure at
plan review. Issues already in Requirements review or later when this ships keep their
record and stage. A native issue shows its record once, in its issue page's Requirements
block, never repeated as a comment in the discussion; a forge-filed issue also carries it
as a comment on the forge, the only place a forge reader sees it.
Approved design: [refinements/issue-flow.md](../refinements/issue-flow.md).
**Why:** the stage earns its place when the operator files a brief note hoping the right
thing is understood; for text that is already precise — alerts, scanner and retrospective
issues, agent- and session-filed issues — a model only restates it, and the restated
criteria then constrain the planner and can rule out a better solution. A padded bug record
added nothing (#clw_01M6RPQZPR8MCB62H3RH8NK0RE): on a webmail login failure the cause was
found from logs only the planner reads.

### Hold work in a backlog a human promotes, or until a date a human chose

An issue can be parked as "not now, but some day": it is off the board, every Claws job
skips it, and no automation moves it out again unless a human parked it until a date. The planner may send an
operator-task issue there, because a human has to act (#clw_01M4RW0DDM0PSNEBDM5J11AKGE). Only a human promotes it back to
Drafting or Requirements review (or to Planning, when it already has a plan or approved requirements), after which
it is planned as normal (see [issue-tracker.md#backlog](../issue-tracker.md#backlog)).
Every newly filed issue lands on the board first and reaches the Backlog only when a human moves it (#clw_01M59YJTDN1Q23S57ATXXT0SC2).
An operator (or a session) may instead park a native issue until a calendar day. When the day
passes, Claws takes it out of the Backlog to where a Promote would land it, verifies an existing
plan against the current state of the repositories, merged PRs and comments — keeping it
unchanged when it still fits, revising it with the earlier version under Previous plans when it
does not — and plans an issue that had none. The requirements record and its approval are
untouched, the operator is told once (an issue comment saying whether the plan
was kept or revised; no Slack line) and reviews it through the normal plan-review gate. Moving the issue out
before the day clears the date (#clw_01M52A1VC256AJHN5DYMX64T5Y; see
[issue-tracker.md#parking-until-a-date](../issue-tracker.md#parking-until-a-date)).
An issue whose open PRs all wait on an operator step, with nothing running, may be sent to the
Backlog too: its held PRs stay open and held and nothing works the issue until it comes back
(note 294, home-assistant-config #94 → #96; #clw_01M7BBKF0M3JX2BDJTZRYFNGB0).
**Why:** an issue filed straight into the Backlog is never seen where the operator looks for work, so every new issue lands on the board first. Without the Backlog the board doubles as the backlog. Every idea is auto-planned within
minutes and piles up in Awaiting plan review, which hides the real to-do list. Work that
must wait for wall-clock time — a week of metrics before right-sizing a deployment — otherwise
lives only in an operator's memory: Claws either attempts it too early or never returns to it
(#clw_01M52A1VC256AJHN5DYMX64T5Y).

### Park work only with Blocked or Backlog, not a separate ignore label

A human who wants Claws to leave an issue or pull request alone moves it to Blocked ("waiting
on something"), to the Backlog ("not now"), or closes it as not planned; Claws offers no third
"ignore" label. Claws' own internal holds — a disposable issue preview's draft pull request, an
issue import still in progress — are recorded without a label a human can see or apply, and an
interrupted import is parked in the Backlog with a comment for the operator. The retired
**Claws Ignore** label was moved to the Backlog on every open item and deleted from every
managed repository (#clw_01M55F0ACDZP8ND1BNRZ8TNGPD).
**Why:** every job already treated Claws Ignore exactly like Blocked and Backlog, so it only
added a choice with no distinct behaviour and a board chip of its own, while internal markers
sharing a human-facing label made it impossible to tell an operator's park from Claws' own.

### Do not create work for a no-action outcome

Automation must filter a verified no-op, duplicate, blocked, or wrongly routed outcome
before creating unnecessary follow-up work, while retaining an actionable explanation.
A companion issue a headless agent files for work an open issue already covers is such
a duplicate: Claws returns the open issue and notes the extra caller on it instead.
The same applies to issues Claws files or imports itself (#clw_01M4RW0TECEKTFT6ZY6GS18DH3):
a reminder issue Claws files itself is held in Blocked on the board, with a reason, and never planned;
a dependency bot's tracking issue (Renovate's Dependency Dashboard) is never imported;
a CI-runner issue duplicating a `main-build-monitor` failure is closed on the forge
instead of imported; and an `upstream-watcher` alert that a watch-file change fixes is
planned normally rather than filed already ignored.
**Why:** a backlog full of un-actionable issues hides work that needs attention.

### Show the planner recently fixed issues a new failure repeats

When Claws plans a native issue, the planner is also shown up to five issues in the same repository closed as completed in the last 14 days that share its title, original title or a non-null dedupe key, each marked closed. The planner builds on their diagnosis and records a `relates_to` link; a closed issue is never a duplicate target that swallows the new issue.

**Why:** A fix that did not hold left the next failure unable to link to its closed root-cause issue, so the planner re-diagnosed by hand (friction note 226, retrospective #clw_01M6TTA8R59VPVKCF4BXPRNGSX). Seen with #clw_01M6NQ2YMZPS0F2E9B476H7HP3, whose TLS failure came back; raised in #clw_01M6V6CAKK3D3F8YMM6HZRKX8Q.

### Capture agent friction cheaply and triage it in a fortnightly retrospective

Every agent, headless or interactive, must be able to record a small out-of-scope
niggle — a slow or flaky command, a confusing doc, a tool returning the wrong shape —
as a one-line categorised note with the `claws_note_friction` tool, which files no
issue and changes no board state (#clw_01M5SKZK2FXT9BFKZBPZ4QBDE4). Claws must roll
every enabled repo's untriaged notes up into one fleet-wide native retrospective issue
that names claws and every repo that contributed a note as its repos, so its plan may
open PRs in any of them, while the claws repo stays its owner, on a Friday once
two weeks have passed since the last one, or as soon as 50 notes pile up across all
repos. The retrospective is a triage list, never one unit of work: it leads with a short
list of proposed follow-up issues, each with its theme, the notes supporting it, the repos
it touches and a one-line outcome, and is held for the operator without ever being
planned or implemented. The operator files the follow-ups they choose — Claws never files
them on its own — and then closes it.
A note counts in one retrospective only, no notes means no issue, and `/retro` shows one
fleet-wide clock and count with the pile grouped by repo.
**Why:** a niggle is too small to justify an issue, which is planned within minutes
and takes operator attention, so agents either over-file or stay silent and the same
friction recurs; triaging a fortnight of notes together gives the operator the wider
view. Planned as one piece, a retrospective became a single spec spanning many repos
(#clw_01M63XDX3ASPFZ7RY3H42S7G10); what the operator needs from it is candidate
follow-ups to pick from.

### Run headless agent shell commands in plain bash

Every shell command a headless agent run (planner, issue-worker, review-addresser,
ci-fixer and the other roles) executes must behave as non-interactive bash: an unquoted
glob that matches nothing is passed through, a leading `=word` is not expanded, and
`grep` is GNU grep or a documented drop-in that accepts GNU flags
(#clw_01M5WW2MS5GQDDRBTWZ3FJWC0Z). Claws pins `SHELL` and `CLAUDE_CODE_SHELL` to bash on
every CLI child; `grep` inside Claude's Bash tool is Claude Code's own ugrep shim, which
accepts `--include`, `-r`, `-n` and `-E`.
**Why:** agents write bash one-liners, and each zsh hit costs a failed command and a retry.

### Run each repo's local checks in the agent pod

Every headless agent runs in its own Kubernetes pod (6 GiB memory, 24 GiB ephemeral
storage) and installs dependencies, builds and runs the repo's full local check suite there
before pushing: `npm ci` with dev dependencies and native modules, type-check, lint, unit
tests, `task validate`, `nix develop -c …` with the repo's own flake devShell, and kustomize
builds. The toolchain comes from the agent image (single-user Nix, python3, make, g++, yarn/pnpm via corepack), never
from an agent installing packages at runtime. End-to-end and browser tests, container image
builds, and anything needing a live app or a cluster stay CI's, and CI stays the source of
truth (#clw_01M5WMKGESZQKEGQW0T8V91MBW).
**Why:** a problem the repo's own checks would catch should be caught before the push, not
after a CI round-trip, and agents kept rediscovering install workarounds on every task.

### Give every headless agent read access to every managed repo

Every headless agent role (requirements writer, planner, issue worker, reviewers, CI fixer,
diagnoser, escalation reviewer and the job-level agents) holds the least-privilege Forgejo
read credential from its first command and is told to read other managed repos through the
Forgejo API only — no `gh`, GitHub token or GitHub fallback. That read covers files,
issues, pull requests, reviews, comments and Actions runs. It is read-only: no role gains
write access to a repo other than its working repo. Any prompt that lists an issue's repos
says the primary repo is the worktree and the others are read over the API
(#clw_01M5WWF9VBN1F3K3NPKFWYD6X1).
**Why:** managed repos depend on each other, and a role that cannot read the repo where the
fix lives scopes the fix out or guesses.

### Manage work only on Forgejo; use GitHub only as the public snapshot target

Every repository Claws manages is on Forgejo, found by Forgejo discovery (plus
`CLAWS_FORGEJO_REPOS`). Claws discovers, polls, dispatches, reviews, merges and files issues
only there, and agents and interactive sessions get Forgejo credentials only: no GitHub
token, no `gh` session capability, and no prompt, capability text or doc telling them to use
`gh` for a managed repo. GitHub is used only to push the scrubbed public snapshot copies
(including TempoStatusBar's release mirroring), with the GitHub App held by the controller
alone, and for the upstream watcher's reads of outside projects
(#clw_01M5VW1FVEPCYG33BN268PWTWZ, 2026-10-26).
**Why:** every St-John-Software repo moved to Forgejo and its GitHub copy is archived, so the
GitHub code paths, credentials and guidance only cost upkeep and sent agents to stale copies.

### Route misplaced work to the repository that owns it

When an approved native issue's work belongs in another managed repository, the planner,
headless included, plans a PR there, and saving the plan adds that repository to the issue.
The issue's primary repository is pinned first, so it keeps planning and labels. A
companion issue in another repository is only for work outside the issue's requirements, and
a forge-numbered issue still keeps its PRs in its own repository.
**Why:** users should not have to recreate a correctly diagnosed report by hand, and a
headless planner that could neither move the work nor add the repository ended the issue
Blocked instead of planning it (friction note 154).

### Keep repository-specific policy with the repository

Settled per-repository automation choices belong in the repository configuration; host
configuration is an operator override only, with clear precedence and fail-open reads.
A repository's root instructions file is `AGENTS.md` and its role documents are
`.agents/<role>.md`, so one canonical location holds each, whatever agent reads them.
**Why:** onboarding and review of repository policy should happen in that repository.

### Offer a per-repository job opt-out only where it is a real choice

The operator's per-repository job control lists only the advisory and housekeeping jobs a
repository can meaningfully opt out of, with the sub-scanners as one control. Pipeline jobs, a
job that only acts on Claws' own repository and a job that is already opt-in by its own
configuration have no per-repository switch: a repository leaves the pipeline by being disabled
as a whole. Fine-grained exclusions (one sub-scanner) are made in the repository's own
configuration and shown as a partial, locked marker. Each disabled cell says whether the
repository's own file or the host override set it, and no exclusion in force before a change of
this kind may turn back on.
**Why:** the operator found a 32-job by 23-repo checkbox grid unreadable ("This is madness"):
almost every cell was a non-choice, and the host-only state it hid is what "Keep repository-specific
policy with the repository" forbids (#clw_01M6NVMC3A93JSFXPGCRNSQB10).

### Create a repository on request

When work needs a repository that does not exist yet, an agent or session asks Claws for it
(`claws_create_repo`) and Claws creates a private repository in the organisation on Forgejo,
seeds it with an enabled `claws.json` and a stub `AGENTS.md`, and the dashboard and API show it
as managed by the time the request returns (background jobs within five minutes). Asking again
for a name that exists returns that repository instead, finishing an earlier request that stopped
before seeding; an existing repository Claws did not create and that has no `claws.json` is
refused and left untouched, since onboarding it is a reviewed pull request.
Repositories are created only in the organisation, only on Forgejo, and only private.
**Why:** the operator should not have to create a repository by hand before Claws can work in
it (#clw_01M6E2HBCJJ79SSFFX3VHSF994).

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

The PR dispatcher decides this itself, before any agent run starts: a pull request with no
new commits since its last review and no pending rebuttal, one whose CI fixer gave up on the
current head, or one with branch-modifying work already running gets no reviewer run, and its
queue entry still says why. A reviewer or review-addresser run that skipped its pull request
queues no auto-merger sweep. **Why:** each agent run is its own pod, and on 2026-10-29 one
dispatcher cycle launched 12 pods of which 2 did real work; the churn of pod network
interfaces disrupted the node's desktop (issue clw_01M63KWT4ECG1X4VEHRS2NYHPC).

### Re-review a head whose blocking finding was addressed without a commit

When the review addresser finishes a round on a blocking review without pushing a commit
(it declined the finding, or addressed it outside the diff, such as by editing the PR
description), Claws re-runs the reviewer once on that same head in the next dispatcher
cycle, telling it to check the PR's current description and state, not only the diff. If
that review still blocks, the pull request is escalated to a human and its issue moves to
Blocked with the reason. A blocking verdict must never stand silently on a head no commit
will replace.
**Why:** home-assistant-config PR #91 (#clw_01M70FCX12JSQHEETB2BEMK1F6) stalled from
2026-11-10 to 2026-11-13: the addresser fixed the reviewer's PR-description finding through
the API with no commit, the reviewer only re-reviews a new head, and the auto-merger kept
editing its "review status is `issues`" comment while the issue looked like normal work in
progress (#clw_01M7A99ZDDHJKY179DMPKMD9V8).

### Launch no agent pod for a pull request row that has nothing to do

Before queueing a pull request review, Claws applies the reviewer's cheap checks: head unchanged since the last review, no rebuttal pending, no branch-modifying work active, and not waiting only on a human (a recorded manual action, or a CI-fixer give-up on the current head). A merge sweep is queued only when a handler reviewed, pushed or changed pull request state, never on a skip path.
**Why:** about 160 no-op agent pods an hour on 2026-10-29 churned the network interfaces of the off-node lane host and broke its desktop; moving them off that host was rejected because it must stay schedulable (#clw_01M63KWT4ECG1X4VEHRS2NYHPC).

### Keep forge reads for closed pull requests off full pagination

Finding the merged pull requests that reference an issue must not page through every closed pull request of a repository on each cycle; repeated scans pinned Forgejo at its CPU limit. The operator rejected a per-repo incremental closed-PR cache as more machinery than the problem needs, and asked for the simplest option that uses the forge's own indexed search or a small forge-side addition, with results still filtered by Claws' own reference matching.
**Why:** one full closed-pull-request page took 3-28 s against about 0.1 s for an indexed search (#clw_01M63XPT6DFETCV8RWS0KTMD3X).

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

### Re-run a CI failure the fixer attributes to the runner instead of waiting for a human

The CI fixer must recover from runner and infrastructure failures: it reads the failed
steps' log, classes a run whose failed jobs died before any repo-owned step failed as an
outage, and re-runs only the failed jobs without a commit and without counting a fix
attempt. When the fix agent gives up
because the failure looks like runner or infrastructure flakiness, the fixer must re-run
the failed jobs itself, within the existing infra re-run budgets, and only ask a human to
re-run once those budgets are spent or the re-run endpoint is unavailable. A re-run must
never be triggered for a failure the agent attributes to the pull request's own changes.
**Why:** on 2026-10-17 docs-only home-assistant-config PR #23, with Automerge and a clean
review, sat blocked for about four hours on Forgejo run 57 after the job container died
mid-step; the fixer diagnosed runner flakiness and gave up, and a single operator re-run
went green (issue clw_01M54YZVHM34QVMEBN6AN6K7RJ; same wait on electronics PR #14).

A PR check Forgejo cancelled because a newer run of the same workflow, or a newer head,
replaced it is skipped with no issue and no re-run; a cancelled check that nothing
superseded is re-run once.
**Why:** bonkus run 3177 was cancelled by its own `cancel-in-progress` group when a newer
push arrived, yet was filed as a `runner:job-cancelled` issue although run 3229 passed
(#clw_01M7BBK6WGFFABBXADN7YNM1GE).

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

A non-major Renovate update opened by a trusted Renovate identity — the Forgejo `renovate`
account, or an allowed human actor's PAT — merges at any hour without a dashboard approval
once CI is green and Claws' review of its current head is clean. A major update, an infrastructure path or a
recorded merge hold still waits for a human, and the forge `Automerge` label is never read as
approval. The one infrastructure exception is a verified zero-change Tofu plan for the exact
head: any PR that would otherwise merge — one with a stored merge approval, by any author,
Claws included, or a trusted non-major Renovate update — merges without a human when the
newest plan comment for every tofu root the repo plans (a comment counts only when posted by the forge's Actions account or a configured human operator) was last updated after the head
commit and reads zero changes (an import counts as a change), and the `Tofu Plan` check on
the head is green. A diff that touches any CI workflow or action file does not qualify,
with one exception: a trusted non-major Renovate update whose only infrastructure change is
one version string in a tofu or terraform workflow or action file, such as the OpenTofu
version in `install-tofu`. Any change, or a plan that cannot be verified for that head,
still waits for a human, and the PR list says why. A PR merged under the exception carries
the `claws-noop-merge` label, and production-infra's merge-time apply refuses to apply any
plan that is not zero changes for it. A template edit, such as a tailscale `.tftpl`
bump, can plan as zero because the rendered `user_data` is `ignore_changes`, and then
takes effect only at the next server rebuild; the operator accepts that for routine bumps.
The dashboard marks an otherwise-mergeable PR that lacks approval as awaiting approval,
with the reason it is held. A human infra merge approval recorded from the board for the exact head
(see [dashboard-and-integrations.md](dashboard-and-integrations.md#show-an-infra-prs-plan-summary-on-its-board-card-and-approve-its-merge-there))
counts as the human merge for an infrastructure PR. The Merge gate never implies it. It
carries over to a later head whose verified plan lists the same resource changes and whose
tofu workflow and action edits are unchanged. Any other new commit makes it stale
(#clw_01M5WBG6JZ8P3PCYVCQ3PS9BBS, 2026-10-26; #clw_01M7095Y5BKVV7WQ7078Z15GH7, 2026-11-09).
**Why:** after #3399 stopped reading forge labels, every fleet-infra Renovate PR sat
unmerged with clean CI and review; routine bumps need no human judgement, majors and infra do — except a provider bump whose
verified plan is a no-op, which cannot change infrastructure (bstjohn-blog #751, #755).
On 2026-10-19 production-infra #121, Claws' own hcloud 1.69.0→1.70.0 bump, was held
despite a zero-change plan because the exception covered only GitHub dependency bots; the
apply-time refusal keeps drift between that plan and the merge-time apply from reaching prod.
In the two weeks from 2026-10-26, production-infra #527, #707 and #708 (tailscale template
and OpenTofu version bumps with 0/0/0/0 plans) waited 15 hours to 4 days for a click,
and #706's approval went stale when a CI-fixer merge commit left its plan unchanged
(#clw_01M7095Y5BKVV7WQ7078Z15GH7).

### Merge an infra PR whose verified plan matches the operator's plan-stage acknowledgement

When the Planner plans a pull request that changes infrastructure in a repository with a `Tofu
Plan` workflow, it declares the Tofu resources the PR is expected to add, change, replace or
destroy, by root, address and action, and every tofu or terraform workflow or action file it
edits; the plan repeats the list for humans and calls out every replace or destroy. The
operator acknowledges those declarations once per issue, recorded with who and when; a re-plan
that changes any declaration makes the acknowledgement stale, and approving the plan or the
merge never implies it. With a current acknowledgement, an approved infra PR that is
otherwise ready merges without the Approve infra merge button when the verified plan for its
exact head — every root's plan comment, posted by the forge's Actions account or a configured human operator and updated at or after the head commit, with a passing
`Tofu Plan` check — lists only declared changes (an import never needs declaring, and a plan
doing less than declared passes) and every tofu workflow or action file it changes is
declared. Anything undeclared holds the PR and is named on the card and in the Merge blocked
comment; the Approve infra merge button stays the fallback, every other gate still applies,
and a PR with no declaration, such as a Renovate update, is unaffected. Such a merge carries
the `claws-ack-merge` label, and production-infra's merge-time apply refuses any change its
plan comment did not show (#clw_01M7096B0VFCVYAA2ED0ZRHFC2, 2026-11-09).
**Why:** a planned infra change was approved twice — once as a plan, then again as a merge
button click per PR once its Tofu plan existed — although the operator had already reviewed
exactly what it would change; approving the expected changes at the plan stage keeps the
human decision and still holds anything the plan did not foresee.

### Capture tofu destroy consent at plan approval, scoped to the exact addresses the plan names

When a plan's pull request will destroy or replace OpenTofu resources, the Planner names each
one by its exact address — never a wildcard — in the PR's infra declaration and in the plan
text, and the plan-review surfaces show the list above the approval gates. Approving the issue
through Plan (or Merge) also approves destroying exactly those resources: Claws records the set
with who and when, writes each PR's share into the PR description as a marked
`tofu-approved-destroys` block, and adds the `claws-approved-destroys` label so the PR's `Tofu
Plan` re-runs. The implementing agent never writes the block. bstjohn-blog's and
production-infra's destroy guards then pass a plan only when its destroys and replaces equal
that set, on the PR check and on the push-triggered apply after merge, with no manual label or
dispatch; any other destroy fails and is named. Re-planning or withdrawing the Plan approval
clears the consent, and the next sweep strips the block and label so the guard fails again;
re-granting it is a Plan withdraw-and-approve. The `allow-destroy` label and the
`allow_destroy=true` dispatch remain the escape hatch for a destroy no plan named, and destroy
consent never stands in for the infra merge gate's acknowledgement or Approve infra merge
button (#clw_01M70H3K4B7H0SNSAB5XJ8ZFCJ, 2026-11-09).
**Why:** a reviewed DNS record deletion in bstjohn-blog needed the operator to approve the
plan, then add a label to the PR, then dispatch the apply by hand after merge, although the
plan had already named the deletion; tying the consent to the approved plan's exact addresses
keeps the human decision and still refuses any destroy the plan did not name.

### Hold a PR that changes a tofu or terraform workflow or action for a human merge, on any forge

A PR that touches a CI workflow or action file whose path names tofu or terraform is held for a human merge whether it lives in the GitHub or the Forgejo workflow location, even with approval, green CI and a clean review. The one exception is a trusted non-major Renovate update that changes a single version string in such a file and nothing else on an infrastructure path, merged only on a verified zero-change plan for its head (see [Merge routine dependency updates without a dashboard approval](#merge-routine-dependency-updates-without-a-dashboard-approval)). Widening this to workflows that run tofu without naming it in their path is not yet decided.
**Why:** a workflow-only change can apply infrastructure with no `.tf` file changing, as in the production-infra #841 incident that destroyed two production servers; Forgejo-hosted repos keep workflows in a different directory and were being merged unattended (#clw_01M59QZDG6S4KN1CGA4MHP3ZMH).

### Open one Renovate pull request per update and run no Dependency Dashboard

The unit of dependency work Claws manages is the Renovate pull request. Every available update, once past its minimum release age, gets its own pull request on the next weekly run; no managed repository keeps a Dependency Dashboard issue, and repository configs must not defer updates onto one.
**Why:** a dashboard is a single rollup issue Claws cannot manage, and importing one round-trips because Renovate re-creates it. Operator decision 2026-10-16 (#clw_01M521N4S7CFHRJ6VQMHC52CFB), superseding turning the dashboard on per repository.

### Classify Renovate updates by version change when the Update column is absent

When a Renovate PR body has no Update column, major versus non-major is decided from each
row's from and to versions: a changed leading major number is major, anything else (including
a 0.x minor) is non-major, and only a body with neither column stays unknown and held.
**Why:** a Renovate default change dropped the Update column and every non-major PR across the
Forgejo repos sat Ready with green CI until merged by hand (#clw_01M4RJBA47JM8XQA7AEM3B6M0F).

### Merge auto-bump PRs on green CI and a clean review

An auto-bump pull request (an `automation/bump-*` branch with the `auto-bump` label and no
`major-update` label) merges without a dashboard approval once its checks are green and a
Claws review of its current head is clean. No part of its diff is inspected: allowlist edits,
registry-host changes, runner bumps and any other change ride on CI and the review. A
`major-update` bump still needs a human merge approval, and the infrastructure and deploy
gates still apply to every pull request.
**Why:** a structural diff gate that admitted only image-pin rewrites kept holding legitimate
bumps for a hand approval: "Auto-bump PRs held by the structural merge gate" alerts fired about
ten times from 2026-10-30 (#clw_01M6Z3KZCX8XP3PJC596N27Z99, #clw_01M6WWT0RMC0BZ7098C66QE58K,
#clw_01M6W8S252B23KFKS9MCSNRFKN, #clw_01M6VJY1DEE4HTETB45X4EG676, #clw_01M6VDSXE1C4YYYAZM34MD7A2K,
#clw_01M6RE9MP9097HEH4GXRSGYHVM, #clw_01M6NQGZVY9F6XN6GSW86V96KE, #clw_01M6NH7HB7GBDSMVHG2ZQ4TG94,
#clw_01M6CRF9PAP8SQ4PVAHWZK22QW, #clw_01M659BX937DK47MMJX03HP92F), and seven separate fixes widened
it, each broken again by the next kind of bump diff (#clw_01M4ESXSYCQ1HBVT3JV84S23VB,
#clw_01M4GRT6MZFPH2CMDKYJ33VW7D, #clw_01M4RJBRBXFFMCMXABNBB3T7PD, #clw_01M4RV5WKJT5XQN89BKMN7X8RH,
#clw_01M5359MZ63V20XB4T4BC3M1W2, #clw_01M64CQ46A14535D86H148D6C2, #clw_01M6KJEBKRHBRH7B5FGQ7J688S).
The operator decided on 2026-11-09 that the gate cost more than it protected
(#clw_01M6ZYAQ1GZXRMTZSQP1V0XA4D).

### Merge generated image-scan PRs while they are still the generator's output

The weekly image scan's advisory-snapshot refresh merges without a dashboard approval
when it changes only the snapshot file, and its exception prune merges the same way only
while it is exactly what the scan generated: only the exceptions file, one commit on the
commit the scan recorded, and no image pin moved on main since that scan. Both still need
a clean Claws review of their head and green checks. Any other snapshot or prune PR waits
for an ordinary merge approval, and the PR and `/prs` say why it is held; Claws never pushes
review nits or conflict resolutions onto these branches (#clw_01M61EFZ6ZZM8FWGN2PAH3KNZB).
**Why:** the repos said the `auto-bump` label made Claws merge these PRs, but only
`automation/bump-*` was exempt, so production-infra #296 sat unmerged from 2026-10-23,
alongside #374 and fleet-infra #516, while a snapshot older than 21 days becomes a scanner
error that breaks PR CI; and #516 absorbed five model-resolved conflict merges that
corrupted two entries, so a modified prune must not merge unattended.

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
by the operator and by agents. Work that depends on a still-open issue — or on the one step of it the issue
needs — is never implemented; when its last open dependency closes, however it
closed, or the step it needs lands, the
dependent issue leaves Blocked on its own, re-planned or marked ready as its
plan warrants, with a comment naming what cleared. While it waits, the board
shows it in Queued, naming the issues it still depends on — including when the
planner reports it blocked while it has such a link open — not in Blocked, which
it reaches only if the operator re-blocks it with a reason of their own. The planner sees an issue's
relationships and records a dependency it discovers as one rather than only in
prose.
**Why:** a dependency that lives only in a plan comment is never re-checked, so
an issue parked on work that has since shipped sits Blocked until a human
notices; the tracker is the one place both issues are, so it is where the
relationship belongs. An issue that needs only one PR of a long plan should not
wait for the whole plan to close (#clw_01M7BBKF0M3JX2BDJTZRYFNGB0). Extends
[Track work in Claws' own issue stream](#track-work-in-claws-own-issue-stream).

### Let an agent leave an informational note on another issue

`claws_comment_on_issue` with `note: true` posts an informational note on
another issue, such as "PR X changes Y you depend on". The note shows on the
issue page and in that issue's planner and implementer prompts as context. It
never withdraws plan approval, never moves the issue back to Planning and
never starts a re-plan or a PR follow-up. A plain comment stays feedback. The
planner prescribes a link plus a note for cross-issue coordination, never a
feedback comment on a sibling issue.

**Why:** #clw_01M6V6C1G4FJ67CXHHKZT0XW4Z — a plan told the implementer of
#clw_01M6P6EX2MQ5E2R2AGKFKM8EXC to comment on an in-progress, plan-approved
sibling, and every comment counts as feedback that withdraws that approval.

### Make generated plans durable and reviewable

Plans and other text intended for onward posting must be collected as complete authored
documents, not accidentally replaced by later process output. A plan's sections must be
written so the operator can find its decisions and steps at a quick read (lists and short
items, not unbroken prose).
**Why:** operators approve the document they see, so it must be the agent's intended plan, and the approval gate is only as strong as the plan's readability.

### Lead every plan with the action approval triggers

Every plan opens with a short plain-language statement of what will be done on approval and
what will behave differently, naming each repository that gets a pull request. Diagnosis and
rationale come after it and are labelled as such; a plan without the statement is rejected at
save time and the planner is asked to add it.
**Why:** the operator could not tell from the plan for clw_01M59KCP5BTY4WEAEDRAGYVSXY what approving it would do.

### Carry design-changing feedback through to a revised plan and requirements

Feedback on an issue with an open PR must be classified as answered, a plan amendment or
a design change. A question gets only a reply. An amendment edits the plan in place, keeps
the open PR, and names which open PR, if any, must change to match. A design change — PRs
added, removed, reordered or redirected, or the requirements contradicted — must store a
new, unapproved requirements version and a plan marked pending re-approval, hold every
open PR it supersedes from merging, and name each with its fate (closed, reworked or
kept). While it waits the issue sits in a column that says it needs a decision. No PR is
closed or reworked until the operator promotes the new requirements or approves the issue through Plan;
then the superseded PRs are closed or re-targeted, no stale `(N/M)` marker counts as
covering a step of the new plan, and the normal implement flow resumes.
**Why:** a design change accepted only in a reply left the plan and requirements at their
old versions and the issue stuck in Awaiting merge, so the operator had to close PRs and
move columns by hand — and an old PR's phase marker could silently count as covering a
step of the new plan.

### Keep merged steps done across a design change

A design change must say what happens to every step PR that already merged: kept as
covering a step of the revised plan, or retired because it shipped and the revised plan
has no step for it. Approving the change must never unlink a merged PR on its own, so a
shipped step never reads as uncovered or ready again in `claws_issue_phases`, the
dispatcher or the board, and is never offered to the implementer again.
**Why:** an 8→10 re-plan unlinked the four merged steps no fate named, and the coverage
fence then hid their old markers, so shipped work read as ready to implement again
(#clw_01M7BBKF0M3JX2BDJTZRYFNGB0).

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
must be retired once the plan is decided — approved (through Plan) or closed. A PR-less
preview (a bare `claws/preview-issue-<ref>` branch) must be found and mirrored the same
way in every managed repository, and every managed repository
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
spend the top tier outside planning on its own. The fleet-wide default tier for each phase, and for
each scheduled or background job that runs on a fixed tier, must be viewable and editable on the
Config page and apply to the next run without a deployment; when a configured default chose a
phase's tier, the issue's model plan names the default as its source.
**Why:** the model used to be decided by five unrelated mechanisms (plan prose, PR markers,
a complexity classifier, a fleet default and provider labels), so an operator could neither
see which one won nor override it without editing text an agent had written; and changing a
fleet-wide default needed a code change and redeploy (#clw_01M6NHWETDWYMCPP68NDQ9D117).

### Run the requirements writer on the operator-configured default tier

When neither the issue's model plan nor a label sets a tier, both the first requirements write and
every refine run use the configured requirements default: `opus` unless the operator changes it on
the Config page. An explicit model-plan cell still overrides it, and a deep-plan request still
raises the first write to the top tier.
**Why:** the writer must infer the problem a short note meant, and the cheaper tier repeatedly
inferred the wrong scope, e.g. scoping a fleet-wide observability standard change to Claws' own logs
(#clw_01M6M7KNYK60WPEBVVM6VEQFBX).

### Plan an incident alert ahead of ordinary queued work

An issue carrying an incident label (the built-in `grafana-alert`, or any label a
repository declares under `incidentLabels` in its `claws.json`) must be planned before any
non-Priority queued work, and must not wait for a free worker: a reserved priority-only
worker picks it up within one dispatcher cycle of the issue being opened.
**Why:** an outage's cost is measured from detection to a plan somebody can act on, and the
queue's merge-first ordering, right for routine work, left fleet-infra#1596 waiting 55
minutes behind PR reviews on 2026-09-24.
Planning and requirements work (issue-refiner plans, refines, replans, verifies and
follow-ups; requirements writing and refining) has its own reserved worker lane, so it
waits only behind other planning work, never behind a wave of PR reviews, and the queue
view shows which lane each row is in. **Why:** a planning task waited 40+ minutes and
requirements writers 1.5 hours behind ~48 queued pr-reviewer tasks (#clw_01M5WMKGESZQKEGQW0T8V91MBW).

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
