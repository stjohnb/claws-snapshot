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

### Keep label state aligned with the actual lifecycle

Issue and pull-request lifecycle state must communicate whether work awaits
requirements, planning, human input, review, CI, or merge, and must not strand
work after a docs-only follow-up. Claws' own store is the source of that state
— a field on Claws-tracked issues today, and a record per pull request once
[Hold pull request state in Claws' own store](#hold-pull-request-state-in-claws-own-store)
is built — and forge labels mirror it for anyone reading the forge; no
automated decision reads a label on a pull request. When a mirrored pull-request
label is removed on the forge while Claws' record still holds it — **Manual Action**
today — Claws restores the label rather than clearing the record, and an
approved pull request the record still blocks says so on the pull request.
**Why:** operators use the dashboard and the labels as a view of reality and need
them to agree; a label any actor can apply is not a safe input to a decision. A
pull request that looked unblocked on the forge while its record still blocked the
merge sat unmerged with no visible reason (#clw_01M3M5ED6YNE8FTNE3QR8JR3XX).

### Hold pull request state in Claws' own store

Every pull request Claws works has one record in its own store — the issue and
plan phase it implements, its stage (opened, CI failing, awaiting review,
addressing review, awaiting merge, needs a manual step, problematic, merged,
closed), the CI and mergeable state last observed, the review verdict of its
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

### Capture requirements before planning

An issue can be filed as a short note. Before any plan is written, Claws reads
the repository and writes a requirements record — title, context, the ask
restated precisely, acceptance criteria, what is out of scope — as a versioned
record separate from the plan, which the person corrects by commenting and then
promotes; the planner plans against the approved version and no longer restates
the requirement itself. Every issue goes through this stage, bug or feature,
native or forge-filed; issues from unattended sources (automations, forge
imports) promote themselves once the record exists, attended ones wait for a
human, and a repository's configuration can override either default for issues
not filed on the New issue form, where the author chooses per issue. A bug or
an alert issue promotes itself once the record exists whatever its source,
overriding the attended-source default for those two shapes: the human's gate
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

### Hold work in a backlog a human alone promotes

An issue can be parked as "not now, but some day": it is off the board, every Claws job
skips it, and no automation ever moves it out again. Only a human promotes it back to
Ideas (or to Planning, when it already has a plan or approved requirements), after which
it is planned as normal (see [issue-tracker.md#backlog](../issue-tracker.md#backlog)).
**Why:** without it the board doubles as the backlog. Every idea is auto-planned within
minutes and piles up in Awaiting plan review, which hides the real to-do list.

### Do not create work for a no-action outcome

Automation must filter a verified no-op, duplicate, blocked, or wrongly routed outcome
before creating unnecessary follow-up work, while retaining an actionable explanation.
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

### Process third-party dependency updates out of hours

Third-party dependency-update pull requests (Renovate, Dependabot) receive review, CI-fix,
review-addressing and merge work only inside a configured out-of-hours window, and are
visibly waiting outside it; their schedules should open them inside that window. Claws'
own-app image bumps are never delayed.
**Why:** on 2026-09-24 pull-request work on bot PRs held both work workers from 13:54 to
16:14 and no planner run started.

### Spend no agent work on a pull request that waits only for a human

A pull request that already carries a completed, up-to-date review and is waiting only
on a human to merge or comment must not receive a fresh CI-fixer or reviewer-agent run
merely because it remains open or because CI reruns for a reason unrelated to a new
commit on it. A pull request that genuinely needs attention — a human requests a change,
new review feedback arrives, or the pull request's own commits break CI — is unaffected.
**Why:** a pull request that is reviewed, green at review time, and waiting on the owner
must not consume agent runs or CI reruns merely by staying open (issue
clw_01M3F9340HHVH185YR16PXVKWK).

### Merge routine dependency updates without a dashboard approval

A non-major Renovate update opened by a trusted Renovate identity — the Renovate app, the
Forgejo `renovate` account, or an allowed human actor's PAT — merges inside the out-of-hours
window without a dashboard approval once CI is green and Claws' review of its current head is
clean, as Dependabot's updates already do. A major update, an infrastructure path or a
Manual Action still waits for a human, and the forge `Automerge` label is never read as
approval. The dashboard marks an otherwise-mergeable PR that lacks approval as awaiting
approval, distinctly from one only waiting for the window.
**Why:** after #3399 stopped reading forge labels, every fleet-infra Renovate PR sat
unmerged with clean CI and review; routine bumps need no human judgement, majors and infra do.

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
while work on them is in flight. A native issue carries its own files — images,
archives, arbitrary binaries — and agents receive them the same way they receive
a forge issue's attachments. An item concerning several repositories gets one
plan, which names the PRs it needs in each of them and which of those PRs
depend on which, with no companion issues, and PRs that depend on nothing
still unmerged proceed in parallel;
an item with no repository yet can be filed and discussed but is not planned
until it has one. Sessions and headless agents file and comment on items
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
is still one piece of work to the operator.

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

### Verify who approved, not just that an approval exists

A human-in-the-loop gate must check the approving identity — an allowed actor that is
not Claws itself — not merely that an approval signal is present.
**Why:** Claws' own forge accounts can emit every signal a human can, so an approval
an agent can produce for itself is not supervision.

### Attribute review feedback by author identity, not by content

Whether a comment counts as human direction must follow from the login that posted it.
Content written by Claws' own account is never authoritative human feedback, however it
is marked.
**Why:** an agent holding the forge token chooses what it writes but not who it is, so a
body marker is not an attribution check.

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

## Non-goals & rejected ideas

- Do not use GitHub issues as a substitute for higher-level, multi-issue goals.
- Do not automatically merge dependency updates merely because their changes are small.

## Open questions

- Whether a runtime-configurable agent SDK should replace CLI-driven agents remains approved but unbuilt.
