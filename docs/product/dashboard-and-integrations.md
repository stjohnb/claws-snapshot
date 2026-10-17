# Dashboard and integrations

**Reference.** Read this when changing dashboard behaviour, external services, or
operator workflows. Read [operations and safety](operations-and-safety.md) for deployment
and alert safety constraints.

## Problem

The dashboard and integrations must make automation actionable without hiding important
state behind host access or forcing users into fragile manual workflows.

## Users

The owner monitors work from the dashboard, working from a phone, a tablet and a
large-monitor desktop, and connects Claws to repository, messaging, and home
integrations.

## Requirements

### Keep active sessions distinct from historical sessions

The sessions page shows active sessions first, retains a searchable combined history,
and makes it possible to resume or inspect a session's history.
On a phone, each active session is a compact card showing repo, ID, status and summary,
with End always visible and less-used details on demand.
**Why:** active work must be easy to find without losing useful past context.

### Keep aggregate repository views actionable

Cross-repository issue and pull-request views must expose real CI and review state and
offer only actions that meet the applicable merge safety gate. The Status page's agent
queue lists every queued or running item across every managed repo, with its issue and
title, and a Prioritise control the operator can act on directly rather than having to
open each repo's own queue.
**Why:** an aggregate dashboard is useful only if it supports safe decisions.

### Work on phone, tablet and large-monitor desktop

Frequently used workflow views remain reachable on mobile. Mobile data entry puts the
task before explanatory material while retaining necessary context on demand. Every
user-facing page uses the available width on a large monitor, has no side-scrolling
primary content on a tablet, and collapses tables to cards on a phone. The nav is one
bar with the same layout on every device: the three most-used views (Board, PRs,
Sessions) pinned on the left, then a More menu holding every other destination and the
account menu on the right. Each destination appears in the nav exactly once, the current
page is marked, and the bar never wraps, from a 360px phone upwards. At a given window
width the bar sits in the same place on every page, whatever that page's content width.
**Why:** operators use the dashboard away from a desktop, on whichever device is at hand.

### Show how many items wait on the operator, and how many sessions are active, in the nav

On every page with the nav, the Board link shows how many open issues sit in the
board's operator-waiting columns (Requirements review, Awaiting plan review, Blocked,
Awaiting merge). The Sessions link shows how many sessions are active, the same ones the Sessions page lists as active; with none active it shows no count. The PRs link shows how
many open pull requests the PR list flags "Needs you": the CI fixer gave up on the
current head (even with Automerge applied), a manual action or operator step is
pending before merge, the PR is Claws Problematic or CI-blocked, or the merge is
blocked on something only a person can resolve (stacked, re-approval hold, auto-bump
gate, infra, mixed doc or ideas change, held checks). Human-authored PRs in the list
count too. A PR merely queued for automerge with green CI does not. The count and the
list's "Needs you" line come from the same predicate, so they agree. An issue parked for its stalled pull request counts
once on Board, through Blocked, and its pull request once in PRs. A count of zero shows nothing. The counts are read on every page load,
follow the same definitions the board and PR stages use, and are part of the link's
accessible name. The bar still never wraps from a 360px phone upwards; large counts show
as `99+`. A count that cannot be read is omitted rather than shown wrong.
**Why:** to learn whether anything needed them, the operator had to open the Board or
the Issues and PRs lists and look.

### Let the PRs list narrow to the PRs that need the operator

The PRs list offers a "Blocked" filter that shows exactly the open pull requests flagged
"Needs you", human-authored ones included, and a count that matches the nav PRs count.
Choosing All returns to the full list; with nothing to act on the filter says so.
**Why:** an operator who sees the count can go straight to those PRs instead of scanning the list.

### Retain the fixed damp-reading record

Damp readings use the owner-defined measurement points, save incremental entries, and
show the points together with construction context.
**Why:** comparisons over time are valid only when the fixed collection and partial entries survive.

### Run voice transcription locally by default

Voice-note transcription runs with the service or its local runtime and is enabled by default
for the supported messaging flow.
**Why:** remote transcription and external credit dependencies proved unreliable.

### Route a voice-note issue to the repository it names

A voice note that names a managed repository is transcribed with that name spelled correctly
and the issue it creates lands in that repository, not a topically similar one.
**Why:** voice notes are the owner's mobile intake path, and a misrouted issue is planned
against the wrong codebase before anyone notices.

### Let a repository provide its own UI guidance

Repositories with a user interface should have their own design guidance rather than
adopting a global visual prescription.
**Why:** user-facing choices are specific to the repository and its audience.

### Set lifecycle state through one control

The operator sets an issue's lifecycle state by moving it between columns on the board or
with the issue page's comment-box status buttons (including **Mark refined**), and it is stored as one
field on the issue rather than as label checkboxes. On the board, a card in
Requirements review or Awaiting plan review carries a one-click green-tick button (accessible name and tooltip
"Approve requirements" or "Approve plan"), and the card's **Move to…** select
offers only Closed and Backlog: comments already move requirements and plans
between the shaping columns.
On the issue page only **Mark refined** and **Send to backlog** are one click; every other
move is a "Comment and …" button that posts the operator's comment with it, and
**Comment and mark blocked** records that comment as the Blocked reason.
Drag and drop is unchanged, except that a drop into Blocked asks for a reason and is refused
without one.
**Why:** a single field cannot hold two contradictory states, and the control applies a
complete, valid state.

### Never let an issue enter Blocked without a reason

Every way of marking an issue Blocked — a board drop, the issue page, a session's label or
column tool, and Claws' own parks — either records a non-empty reason in the same write as
the move or refuses the move and says a reason is required, leaving the issue's stage,
labels and History as they were. Every issue entering Blocked through Claws therefore has a
recorded reason its page shows. Issues already Blocked without one are not backfilled, and a
forge issue labelled Blocked on the forge itself is outside Claws' control.
**Why:** the Blocked reason is what an operator reads on arrival at a Blocked issue to learn
what to do; a hand-made Blocked showed "none recorded", so nobody could tell what was being
waited on or how to unblock it (#clw_01M52HEDS02MXDJYQHS72Q44VF).

### Start a session from a board card

Every native issue card on the board, in every column, has a **Start session** button (a terminal `>_` icon whose accessible name and tooltip say
"Start session", on the same line as **Move to…**) that
creates an interactive session for the issue at once, without the New session form. The
session has all of the issue's repositories, primary first (none for an unassigned issue, which
gets a home-directory session), and the agent, model and capabilities the New session form would
pre-select for that repository combination at that moment, including its fallbacks and forced
grants. Starting from a card does not change what the form remembers, and posts nothing on the
issue. The session carries the issue's brief (title, body, latest plan) as an agent-started one
does, and its page says it was started from the board. The session's first user message is
Claws' note naming the issue's `#clw_…` id, stage and repositories, telling the agent to gather
context read-only (state, Blocked reason, requirements, latest plan, discussion, related jobs and
pull requests), pointing at an obvious problem when there is one (Blocked, a stalled pull request,
a manual-action hold, failed work), and to reply with a short summary, flagging a bad state
prominently, then wait for the operator's next message before changing anything; it is delivered as the New session form's Initial prompt is, so
reloading the page or reconnecting the terminal cannot drop or repeat it
(#clw_01M52FQ20JWHEC52TDT61DEZS9, 2026-10-16). **Why:** the operator had to ask the agent to investigate, or find the problem themselves (#clw_01M5379567QD7KBG199N863G36, 2026-10-16). A refusal (for example, repositories
spanning owners) shows the reason on the board and creates nothing. Forge cards have no button,
since a forge issue cannot be dedicated to a session (#clw_01M52AKRRVN170EE506CRZD9VM, 2026-10-16).
While a session started from the card is live (its row not ended) the card shows an icon-only
**Go to session** link to that session in place of Start session, reverting on the next board load
once it ends; sessions started any other way do not change the button
(#clw_01M52M5GF32CCXXYRZBPSZ0ZR8, 2026-10-16). **Why:** without it the operator could create
duplicate sessions and had no way back from the card to the one already running.
**Why:** starting a session for an issue meant leaving the board, opening the sessions page,
re-ticking the issue's repos and checking the agent, model and capabilities by hand; the
session then opened blank, so the operator had to type the issue id before pointing the agent at it.

### Start a session for a pull request from the PRs page

Every pull request row on the PRs page has a **Start session** text button (its accessible name
and tooltip say "Start session for `owner/name#n`") that creates an interactive session for the PR
at once, without the New session form. The session is for the PR's repository, checked out on the
default branch, and uses the agent, model and capabilities the New session form would pre-select
for that repository at that moment; starting it does not change what the form remembers, and posts
nothing on the PR, its issue or the forge. The session knows the PR's repository, number, title,
branch and link, and its linked Claws issue id when there is one; its page says it was started
from the PRs page for that PR. Its first user message, delivered once as a board start's is, names
the PR and tells the agent to gather context read-only and then wait for the operator's next
message before acting. When the PR has an obvious problem — a pending manual-action hold, a
problematic mark, CI the CI fixer gave up on, blocked CI, failing CI or CI held for approval, in
that order — the message names it as the likely subject so the agent can summarise the problem and
what the operator could do; a PR with none gets no such pointer. A refusal shows the reason beside
the button and creates nothing. While a session started from the row is live the row shows a
**Go to session** link in place of the button, reverting on the next page load once it ends;
sessions started any other way do not change the row. It works the same for GitHub and Forgejo
PRs, with or without a linked issue (#clw_01M534FQSS8T19QHHKSVHS9AGY, 2026-10-16).
**Why:** working on a PR meant leaving the PRs page — where failing or blocked CI, a problematic
mark and a pending manual-action hold are shown — opening the sessions page, re-ticking the PR's
repository and re-explaining which PR was meant.

### Show the board as the lifecycle's stages, grouped

The board's columns are the lifecycle's stages — Drafting, Requirements review,
Planning, Awaiting plan review, Approved, In progress, Awaiting
merge, Closed, with Blocked and the Backlog tray — grouped as shaping, building and landing. A column where a
human is needed is marked as such and accepts a drop; a column Claws moves
cards through on its own is derived from the store at render time and refuses
one. Approved and Awaiting plan review accept a drop only for an issue that has
a plan, and a drop into Planning on an issue with a plan starts a re-plan, so no
move leaves an issue in a state the pipeline cannot act on. The two approval
decisions are one icon-only click on the card (a green tick for approve requirements / approve plan), on the same line as
the card's **Move to…** select, which offers only Closed and Backlog. Plan review and
merge review are separate columns. An issue sits in In progress while Claws implements it or automation is still
moving its open pull requests. There is no column for a
pull request that cannot move on until a person acts — CI fixes exhausted, or
CI blocked: Claws moves the issue to Blocked with a reason naming the pull
request, and back out on its own once the pull request is back in the normal
flow. At every width only the columns waiting on the operator —
Requirements review, Awaiting plan review, Blocked and Awaiting
merge — start open; the rest, the Backlog tray among them, start collapsed and
still show their name and card count, and the operator can expand or collapse
any of them for the visit. When the board is filtered to one repository, every
column and the Backlog tray start open instead, and the operator can still
collapse any of them for the visit. A card can be dropped on a collapsed column that
accepts drops. On a phone the groups stack and the folded columns Claws sets
(Drafting and the derived ones) are counted in their group's header.
Drafting holds an issue while Claws owes it a requirements version — none yet,
or a person has commented on the latest one since it was stored — and every
issue with no repository; Requirements review holds one whose latest version
waits on the person. A card moves between the two on its own when a version is
stored or a person comments, with no move and no edit to the issue, and an issue
is promoted from either. A card in
Drafting or Requirements review carries a collapsed preview of the idea — its requirements record's
Requirement part, or the start of the issue body before a record exists — so
the column can be triaged without opening every issue. An Awaiting merge card
lists its open PRs as forge links named by repository and number, in place of
the plan, and each PR held on an operator step shows "Waiting on operator" with
its step. The card carries a "Needs you" chip when every PR is held, still
without leaving the column; one waiting on the operator shows its operator step
above the list. A hand close — dragging
a card into Closed, or the issue page's Close issue control — records the
reason as not planned by default, with a way to instead mark it completed for
work finished outside Claws; the closed card and the issue page show the
recorded reason, so a dropped issue is told apart from a shipped one.
Approved design: [refinements/issue-flow.md](../refinements/issue-flow.md).
**Why:** one Ideas column hid whether an issue waits on Claws or on the
operator, and one In progress column hides three states the operator treats
differently — the implementer running, a pull request cycling through CI and
review, and a pull request waiting for a person — and the same word, Ready,
means "plan awaits review" on an issue and "merge awaits review" on a pull
request. A single PR open column likewise hid the pull requests stuck on a person
among the ones automation was still moving, and a large-screen board with every
column open buried the few cards that need the operator among the many that do not.

### Report an open linked issue's status as its board column

Wherever Claws shows or reports a linked issue's status — the issue page's Links table, the session link tool and the planner's linked-issue context — an open linked issue's status is the column the board shows for it, never its stored lifecycle value.
**Why:** a stored lifecycle can lag well behind the board on multi-PR issues; a dependency in Awaiting merge was reported as awaiting plan review and an interactive session misinformed the operator (#clw_01M533ZA8MA64J1PXJ9PC1HHDH).

### Show how long a board card has waited in its column

Every board card shows, compactly and without growing the card, how long its
issue has been in its current column, and marks it once it has waited too long
in a column where a person must act.
**Why:** a card that has sat in a human-gate column for days is the one the
operator must act on, and nothing else on the board says so.

### Show native issue ids in a short form

Wherever the dashboard shows a Claws-native issue id as text, it shows a short
form that keeps the id's distinguishing characters, while every link, form and
stored value carries the full id.
**Why:** native ids share a long common prefix, so two full ids are
indistinguishable at a glance, but the full id is the only safe key for data.

### Show repository names in a short form

Wherever the dashboard shows a repository as text it shows only the repository
name, while every link, form value and stored value carries the full
owner/name.
**Why:** all managed repositories share one owner, so the prefix costs space
and adds nothing.

### Show each repository's avatar

Every repository the dashboard lists or groups work by — Board cards, the Issues and
PRs lists, Backlog groups, the repository page and an issue's repository chips —
carries a small square beside its name: the avatar its `claws.json` declares, or a
neutral initial when it declares none or the image cannot load. Claws files one
issue in each monitored repository that has not declared one and closes it once the
repository does; what the avatar is and how it is made is the repository's choice. Board cards show only the avatars, one for each repository the
issue names, together at the right of the card's header, apart from the automerge toggle in its top-left corner, and a hover or tap shows
the name.
**Why:** operators watching several repositories should recognise them at a glance
rather than by reading names; the operator reported the board's name pills as noise.

### Keep board columns readable at every window width

Board columns never overlap each other at any window width, including a desktop-width window,
and the board carries no standing explanatory paragraph beneath it.
**Why:** the operator reported columns overlapping on a desktop, and called the board's long
how-it-works blurb useless; column hints and tooltips carry the detail where it is needed.

### File a new issue without leaving the Board or Issues page

The Board and the Issues page each offer a **New issue** button that opens the full New issue
form in a modal over the page; after a successful create the operator stays where they were,
with a link to the new issue. A Board filtered to one repository pre-selects that repository.
See [issue-tracker.md#repositories-and-the-primary-repository](../issue-tracker.md#repositories-and-the-primary-repository).
**Why:** the Board is where operators watch and move work, so it is where they think of new
work, and leaving it for a separate page and coming back broke that flow.

### Link issue and PR references in rendered text

An issue or PR referenced by id in rendered issue text becomes a clickable link to that item
without the author writing a link.
**Why:** the operator wants to follow a reference from the issue page directly instead of
searching for the item.

### Show an issue as request, current plan and discussion, and keep every plan version

The issue page shows a Claws-native issue as its initial request, its current plan and its
comments, each a collapsible block, with the plan split into its sections and every earlier
version of the plan still viewable. Pages that list many issues offer the plan collapsed on
each issue, and opening it shows the plan in an overlay rather than growing the row or card. A Blocked issue's page leads with its recorded Blocked reason in a callout under the title (a long reason expands in place), or says none was recorded. See [issue-tracker.md#plans](../issue-tracker.md#plans).
**Why:** an operator opens a Blocked issue to find what to do, and should find it on arrival without scrolling; the plan is what the operator reviews and approves; once a refinement rewrites it
in place the reasoning it replaced is lost, and a plan buried in a flat comment thread is
hard to find, read section by section, or compare with what came before.

### Show an issue's pull requests

The issue page lists every pull request associated with the issue, in any repository and
any state, each as a link to the PR on the forge with its number, title and state.
See [issue-tracker.md#pull-requests](../issue-tracker.md#pull-requests).
**Why:** operators open an issue to follow its progress, and without the list they have to
leave the page and search the PRs list or the forge to find the PR.

### Show every change to an issue in its History

Every change to a Claws-native issue's lifecycle state, open/closed state, title, body,
repositories, labels, links or Blocked reason, every comment deletion, and every
requirements version stored or approved is recorded, and the issue page lists the
records oldest first in a History block near the bottom, collapsed on load and saying so
when there are none. Each entry names the field with its old and new value, when it
changed, and who made it: the operator, a session, or Claws automation with the job and a
link to its run log. A write that changes nothing records nothing. See
[issue-tracker.md#history](../issue-tracker.md#history).
**Why:** an operator who finds an issue in a column they did not expect needs to see what
moved it and why; the current state alone cannot explain an unexpected change after the fact.

### Let the operator delete a comment on a native issue, recoverably

Each comment in a Claws-native issue page's Comments block has a **Delete** control guarded by
a confirmation. Deletion is a soft delete: the comment leaves the page, `claws_get_issue` and
every prompt Claws agents build from the comments, a `claws-phase-done:` claim or
`claws-duplicate-of:` marker in it stops counting, but the row is kept with who deleted it and
when, and the issue's History records "Comment deleted" with the comment's id, author and
opening text. The current plan comment and the latest requirements comment are not offered
and are refused, so the plan and its Previous plans history are never lost. Deleting never
counts as feedback, re-plans or queues work. Restoring, hard deletion and forge comments are
out of scope. See [issue-tracker.md#deleting-comments](../issue-tracker.md#deleting-comments).
**Why:** long-lived issues accumulate stale feedback, superseded reassessments and audit
noise the operator wants to clear (#clw_01M34R5RDGCPK8WVC3MNG183NZ); keeping the row and a
History entry keeps the clean-up auditable (#clw_01M5001TVYQ36RKG67GSYE64K8).

### Keep public snapshots publishing across forge migrations

A public mirror keeps publishing from its private source regardless of which forge hosts the source, and a source that cannot be found is alerted rather than skipped.
**Why:** a mirror that stalls silently after a source migrates to Forgejo is the failure that blocks the migration batch.

### Keep the primary release Latest on a public mirror

Which release is Latest on a public mirror is decided by an explicit per-pair tag rule, not by the order releases were mirrored; releases from other tag families never become Latest, and a pair with no rule keeps its newest release Latest.
**Why:** a `linux-v*` release mirrored after the app release became Latest and broke the macOS update checker for every installed app.

### Publish a mirror that exists for published writing from an explicit allowlist

A public mirror that exists only to support published writing publishes an explicit allowlist of paths, not "everything minus a scrub list".
**Why:** a deny-list publishes the full inventory of what runs on the home network, far beyond what the blog posts need.

## Non-goals & rejected ideas

- Do not make explanatory text or multi-row dashboard chrome displace an interactive terminal on compact touch screens; a single-row nav is acceptable.
- A native iOS client is not required where the supported web app can provide the needed access.
- Claws does not automate Home Assistant upgrades: on thinkcentre, Core and service versions follow nixos-config's `flake.lock`, and device firmware (Z-Wave, ZHA, Shelly, ZBT-2/SkyConnect radios) is updated by hand (#clw_01M501MVRCMQZ2QXMN410V25DB).
- Claws does not monitor Home Assistant (operator decision 2026-10-15): the deploy, backup, battery, repairs and bin-day monitors were removed (#clw_01M504VV1NB5YB9QNP4KAMQKK7). Agent access to HA is unchanged; replacement monitoring is deferred to #clw_01M5034BWAT7379RB9THG0KJCR.

## Open questions

- Comment moderation for the blog remains proposed and is not a current integration.
