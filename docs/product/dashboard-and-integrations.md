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
On a phone, each active session is a compact card showing its repos as repo icons in one wrapping row (icon plus name for a single repo; each icon exposes its full name on hover and to assistive technology), linking to the session, with status and summary,
with End always visible as an icon button, the whole card opening the session, and less-used details on demand.
**Why:** active work must be easy to find without losing useful past context, and an 18-repo session listed by name stretched its row and pushed the rest of the table down.

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
Awaiting merge), and how many open issues are on the board in all (everything outside the Backlog), as `waiting/total`. Queued issues, which wait only on other work in flight, are not counted as waiting. The Sessions link shows how many sessions are active, the same ones the Sessions page lists as active; with none active it shows no count. The PRs link shows, as `waiting/total`, how
many of the open pull requests the PR list flags "Needs you": the CI fixer gave up on the
current head (even with the merge approved), a manual action or operator step is
pending before merge, the PR is Claws Problematic or CI-blocked, or the merge is
blocked on something only a person can resolve (stacked, re-approval hold, auto-bump
gate, infra, mixed doc or ideas change, held checks). Human-authored PRs in the list
count too. A merge-approved PR merely queued for the auto-merger with green CI does not. The count and the
list's "Needs you" line come from the same predicate, so they agree. An issue parked for its stalled pull request counts
once on Board, through Blocked, and its pull request once in PRs. The badge shows whenever the total is above zero (`0/5` included); a zero total shows nothing, and Sessions shows nothing with no active session. The counts are read on every page load (the Sessions count live, never cached, and updated by the Sessions page with its list so the two always agree),
follow the same definitions the board and PR stages use, and are part of the link's
accessible name. The bar still never wraps from a 360px phone upwards; each number is capped at `99+`
with the exact numbers in the accessible name. A count that cannot be read is omitted rather than shown wrong.
**Why:** to learn whether anything needed them, the operator had to open the Board or
the Issues and PRs lists and look.

### Show every open alert in one place

The dashboard's `/alerts` page, in the nav's More menu, lists every open alert issue Claws
filed: its title (linking to the issue), repo, how long it has been open, how many times
it has recurred, when it was last seen, and its status — "Needs you" when its board
column waits on the operator (the same columns the nav count uses), "Automatic"
otherwise, with the column and, while Blocked or Queued, the first line of the reason. A Queued alert is "Automatic". Alerts that
need the operator come first, then the newest. A newly filed alert appears on its next
load and leaves the list when its issue closes. "No open alerts" shows when there are
none.
**Why:** the operator had no single place to see what was alerting and had to rely on
Slack history, which no longer carries every alert (#clw_01M5YPSK289NXAK8E6K6RNTFS5).

### Let the PRs list narrow to the PRs that need the operator

The PRs list offers a "Blocked" filter that shows exactly the open pull requests flagged
"Needs you", human-authored ones included, and a count that matches the nav PRs count.
The clear-filters X returns to the full list; with nothing to act on the filter says so.
**Why:** an operator who sees the count can go straight to those PRs instead of scanning the list.

### Filter and sort the PRs list

The PRs page is one flat list of open pull requests, not grouped by repository. Filters are added
on demand: the operator picks an attribute (repository, author, label, CI status, review state or
merge state) from an Add filter dropdown, then its value from a second dropdown, and can remove any
filter on its own, so only applied filters take space. They can
combine those filters with the Dependencies, Other and Blocked chips (the active chip toggles
off), and sort by date updated, date created, repository,
title, author or CI status in either direction. A change to any dropdown applies at once, and a
clearly drawn, centred ✕ at the right end of the toolbar clears every chip and dropdown filter, keeping the sort
(#clw_01M5CR15M5G5TDJQ0N1KTCN3C3, #clw_01M5D4K7QVAEB47FYPWRGRDTBD). The filters and sort are kept in the page
address, so a reload, bookmark, shared link or return from a row action shows the same view.
An address with no filters or sort shows every open PR, created-earliest first (#clw_01M5PPBYYP4CDM0N64JA577SW5).
The Blocked count stays the fleet-wide "Needs you" total and matches the nav PRs count whatever
else is filtered. Filters that match nothing say so and offer a way to clear them, and the
page stays usable on a 360px phone.
**Why:** an operator triaging PRs needs to see them by age, recent activity or any other
attribute, flat across the fleet, rather than scanning a fixed grouping (#clw_01M5ATFZA8NKKZ7Y0TK8C3WDTB).
The oldest PRs should be seen first, so the default view is oldest-created at the top.

### Filter and sort the Backlog list

The Backlog page is one list the operator can filter and sort by any attribute it shows —
repository, label, author, title, date created and date updated among them — with repository
one choice among the others rather than a fixed grouping. The current filters and sort live in
the page address, and Promote and Promote selected return the operator to the same view.
**Why:** triaging a large backlog needs it seen by age, by last activity or flat across the fleet
(#clw_01M59YHETQ3V0E0EAJP17S1KFQ).

### Retain the fixed damp-reading record

Damp readings use the owner-defined measurement points, save incremental entries, and
show the points together with construction context.
**Why:** comparisons over time are valid only when the fixed collection and partial entries survive.

### Remind the operator to log damp readings every 2 weeks

Claws files one Blocked reminder on alternate Monday mornings (from 9 AM local) when no
readings have been logged in the current 2-week period, and closes it automatically once
readings for that period are logged.
**Why:** a weekly reminder was too frequent (#clw_01M5WC9AGCZHKZRZM7K2AF930G).

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
with the issue page's comment-box status buttons (including **Approve plan**), and it is stored as one
field on the issue rather than as label checkboxes. Approval is a second stored field, set through the approval track
(see [Show and set an issue's approval as one gate track](#show-and-set-an-issues-approval-as-one-gate-track)),
on the card and the issue page alike. The card's **Move to…** select
offers only Closed and Backlog: comments already move requirements and plans
between the shaping columns.
On the issue page only **Approve plan** and **Send to backlog** are one click; every other
move is a "Comment and …" button that posts the operator's comment with it, and
**Comment and mark blocked** records that comment as the Blocked reason.
Drag and drop is unchanged, except that a drop into Blocked asks for a reason and is refused
without one.
**Why:** a single field cannot hold two contradictory states, and the control applies a
complete, valid state.

### Show and set an issue's approval as one gate track

Every issue on the board, and every open native issue page, shows its approval as one ordered track
of three gates — **Reqs**, **Plan**, **Merge** — with a "Stops at" line under it naming the next
place Claws waits for a human (requirements review, plan review or merge approval) or saying it runs
to merge with no further stop. Each gate is a labelled dot on a line, never a box or a segment: a
filled dot when approved, a ring with a faded centre when pre-approved ahead of the issue's stage, a
half-filled dot for a partial merge approval, a plain ring when waiting, and a dashed ring with the
name in bold for the next stop, so shape tells the states apart without colour. The track replaces the card's old Plan,
Ship, Approve-plan tick and M Automerge controls and the issue page's Refine & Automerge button. It
reads and writes one stored value, the issue's approval (`approved_through`: none, Requirements, Plan
or Merge), with who set it and when — no label — so an approval made any other way (a board move, the
issue page, an interactive session's `claws_set_issue_approval` tool, a monitor filing a routine issue
pre-approved) shows on it, and a session reads the same "Stops at" sentence the card shows.

- The track itself is a read-only status strip: nothing in it can be clicked. The operator acts
  through one filled primary button under it whose visible label names exactly what the click does,
  and only that: **Approve requirements** in Requirements review, **Approve plan** in Awaiting plan review
  once a plan exists, and **Approve merge** when Reqs and Plan are filled and the merge is approvable.
  Planning has no primary button until the plan is pre-approved.
- Approving further ahead than the next gate is one outlined button per further approval attached to
  the primary's right edge as one button group, labelled cumulatively **& plan** and **& merge**,
  each carrying its whole effect as its tooltip and accessible name; in Planning, with no primary,
  **Pre-approve plan** leads the group outlined. Withdrawing never shares the group: beside a primary
  the withdrawals sit in a ⋯ menu, and with nothing to approve each withdrawal is a plain button
  filling the row. There is no **More…** select. The whole effects are: **Approve
  requirements and pre-approve plan** and **Pre-approve plan** (Requirements review, Planning);
  **Approve requirements, plan and merge — no further stop**, **Pre-approve plan and approve merge — no
  further stop**, **Approve plan and merge — no further stop** or **Approve requirements and merge — no
  further stop**, naming every gate the merge approval also fills (the merge can be approved from
  Requirements review onward); **Withdraw plan pre-approval** (or **Withdraw plan pre-approval and
  merge approval** when the merge is approved too); and **Withdraw merge approval**. Claws records who
  approved or withdrew. Approved requirements are never withdrawn from the track.
- No control's effect depends on hover text: tooltips only add detail, so a touch user sees what a
  mouse user does.
- A plan pre-approval is simply the approval set through Plan before a plan exists. It stands for every
  plan Claws writes for the issue — a multi-PR plan is not re-approved per step — until the planner
  withdraws it (lowers it to Requirements, saying why): when its step-back pass says `reconsider`, or
  when human feedback newer than the approval re-plans the issue. A design change that needs
  re-approval lowers it the same way and withdraws the merge approval, so the issue stops at plan
  review and the merge must be approved again.
- **Merge** is filled only when the issue is approved through Merge or every open PR's merge is approved;
  when only some are, it shows a distinct partial state whose tooltip names the approved PRs.
- Unplanned stops — Blocked, Queued, Claws Problematic, a reviewer escalation, Needs LGTM, an awaited operator
  step, a design change pending re-approval, or waiting for import — are not gates: they keep their
  chips, and while one applies the "Stops at" line names it instead. In Drafting, Queued, Blocked, Backlog
  and Closed, and on a card awaiting import, the strip shows the state and no action is offered.

**Why:** four approval controls with inconsistent rules and state left the operator working out from
the column, the M toggle and the Ship label where an issue would next stop; one ordered track says it
(#clw_01M5VRB6Q607S256SQ8NDC5AHT, 2026-10-26; replaces the Plan and Ship buttons of
#clw_01M5QGHYRXSW84J8K9TJVWQQMT). Five labels then still stood behind the three gates, each with its
own writers and readers, so the track and the pipeline could disagree; one stored value cannot
(#clw_01M5VW14RKAAGS6VZ5PCKQXB9F). Filled, outlined and plain buttons read as ordinary buttons rather
than status, so each gate carries a checkbox mark (#clw_01M5WG7MRFV23ZBB7NNF72DYQJ). The clickable
gates still hid each click's effect — approve through, withdraw onward, or nothing — in a tooltip touch
never shows, and their boxes ticked their neighbours, so the gates became a read-only strip with explicit
action controls (#clw_01M5X4HY4YC56Y6VEMK12P2QR7, 2026-10-26). On review the boxed strip still read as a
clickable segmented control, the More… select read as a form field stacked on the Move to… select, the
next gate was stated three times across four or five rows of chrome, and with every control a one-pixel
outline nothing was primary; so the strip became dots and lines, the next approval a filled button with
the further approvals attached, and the withdrawals a ⋯ menu (#clw_01M61A4P3N7D76P1JR2HW5WNN5, 2026-10-28).

### Show a Blocked reason once, readable, and without Claws' bookkeeping marker

The approval track's "Stops at" line names Blocked without repeating the reason; the reason is read in the card's two-line excerpt, its preview modal and the issue page's callout. The modal renders the reason as markdown (bold, code, real bullet lists); the excerpt shows no raw markdown syntax where that is easy to avoid. The `claws-awaiting-operator` marker never appears in any of these places.

**Why:** operator-step reasons are long markdown with machine bookkeeping, so repeating them under the gates filled the card and the modal showed raw asterisks and run-together bullets (#clw_01M5WX77KMHKMZVPJN2BJRS412, 2026-10-26).

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
Clicking Start session leaves the operator on the board: the card immediately shows the **Go to
session** link in place of the button and the board's status line confirms the session started,
with a link to it (#clw_01M59V8PP65C0YRA7F0TPE7VZC, 2026-10-19). **Why:** kicking off several
sessions or continuing triage meant navigating back to the board each time.

### Show an infra PR's plan summary on its board card and approve its merge there

A board card whose issue has an open pull request touching infrastructure paths shows, under
that PR's link in every column but Done, a one-line summary of the Tofu plan for the PR's
current head — additions, changes and deletions, each stated even when zero ("no
deletions"), with replacements when there are any; deletions and replacements stand out in
the danger colour. Counts appear only when the plan is verified for the current head; otherwise
the line says the summary is unavailable for the current head and why, and the PR link stays
there to inspect it. Beside it an **Approve infra merge** button records the operator's
approval for that PR's current head (who and which commit, together with the ordinary merge
approval) without leaving the board, then tries the merge through every other gate. The approval is for the commit the card
showed: if the PR has moved on since the board rendered, nothing is recorded and the card shows
the new head so the operator reviews its plan and approves again. The card
then shows who approved it for which commit and what still holds the merge — a manual action,
CI not passing, no clean Claws review of the head, conflicts, or the auto-merger's last reason —
or that Claws merges it on its next sweep, which honours the approval. New commits make the
approval stale: Claws does not merge on it, and the card shows the approved and current commits
with the button again. The Merge gate never implies this approval, withdrawing
the Merge gate clears it, and without it the auto-merger still refuses every infrastructure PR.
Non-infra PRs show neither the summary nor the button (#clw_01M5WBG6JZ8P3PCYVCQ3PS9BBS,
2026-10-26).
**Why:** infrastructure PRs always need a human merge, and as they became frequent the operator
had to leave the board for each one and work out from the forge what it changed; the summary
says how risky it is at a glance, and the approval keeps the human decision while removing the
trip to the forge.

### Create a session from the issue page

The page of a Claws-native issue must have a **Create Session** button under the title that starts an interactive session dedicated to that issue and takes the operator to the new session's page. The session has the issue's repositories, primary first (none gives a home-directory session), and the agent and model the New session form would pre-select for them, recording nothing. It is set up exactly as a board start: the same repositories, agent, model and capabilities, the same brief and the same opening message (see Start a session from a board card). The session page says it was started from the issue page, the issue gets a Claws-marked audit comment naming the session, and the board card's **Go to session** link ignores these sessions. Activating the button twice creates one session. A failure shows an error beside the button and leaves no session or comment. Forge-hosted issues have no button. **Why:** the operator had to leave the issue and re-enter its repos and context in the New session form (#clw_01M5MMR1XVZ4ER7FJ1826R7K99, 2026-10-23). The operator found a session started from the issue page idle with fewer grants than one started from the card (#clw_01M5WXV4C0AHMH87YP85B2XFNT, 2026-10-26).

### Keep the Board current while it is open

While the Board's tab is visible it refreshes its cards, columns, Backlog tray, per-card Start
session / Go to session controls and the nav's counts every 60 seconds, with no reload, so a change
made elsewhere shows within about two minutes (the forge reads behind it are cached for 60 seconds).
A hidden or background tab does not refresh, and refreshes at once when the operator returns to it.
A refresh never cuts across what the operator is doing: it waits while a card is being dragged or
moved, an automerge toggle is saving, a session is starting, a dialog is open or a card's Move to…
select has focus; it drops a render that was fetched before a move, toggle or session start finished;
and it keeps the repository filter, which columns and the Backlog tray are open, keyboard focus on a
card's control or a column heading, and the page's scroll position.
A failed refresh leaves the last content in place, says nothing, and the next one recovers
(#clw_01M59YYPDF6SQS5RR4JSFDZGJQ, 2026-10-19). **Why:** a board left open on a desktop, tablet or
wall display showed cards in old columns, missed new issues and showed ended sessions as live until
the operator reloaded it by hand, which can hide work waiting on a decision.

### Start a session for a pull request from the PRs page

On a phone, a PRs-page card's actions are a fixed grid of icon-plus-label buttons readable without hover, with each action in the same cell on every card; its CI, Reviewed and Merge blocked chips are icons with an accessible name and tooltip, and chips carrying a count or reason keep their text.

Every pull request row on the PRs page has a **Start session** button (a `>_` icon with the label "Start session" on a phone, a text button from 768px; its accessible name
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
sessions started any other way do not change the row. It works for any PR,
with or without a linked issue (#clw_01M534FQSS8T19QHHKSVHS9AGY, 2026-10-16).
**Why:** working on a PR meant leaving the PRs page — where failing or blocked CI, a problematic
mark and a pending manual-action hold are shown — opening the sessions page, re-ticking the PR's
repository and re-explaining which PR was meant.
Clicking Start session leaves the operator on the PRs page: the row immediately shows the **Go to
session** link in place of the button, with a "Session started" confirmation beside it
(#clw_01M59V8PP65C0YRA7F0TPE7VZC, 2026-10-19). **Why:** kicking off several sessions or
continuing triage meant navigating back to the PRs page each time.

### Show the board as the lifecycle's stages, grouped

The board's columns are the lifecycle's stages — Drafting, Requirements review,
Planning, Awaiting plan review, Approved, In progress, Queued, Awaiting
merge, Closed, with Blocked and the Backlog tray — grouped as shaping, building and landing. A column where a
human is needed is marked as such and accepts a drop; a column Claws moves
cards through on its own is derived from the store at render time and refuses
one. Approved and Awaiting plan review accept a drop only for an issue that has
a plan, and a drop into Planning on an issue with a plan starts a re-plan, so no
move leaves an issue in a state the pipeline cannot act on. Approval is shown by the card's
read-only approval strip (Reqs → Plan → Merge, with its "Stops at" line) and set with the
**Approve …** button, its attached **& plan** / **& merge** buttons and ⋯ withdrawal menu under it, above
the card's **Move to…** select, which offers only Closed and Backlog. Plan review and
merge review are separate columns. An issue sits in In progress while Claws implements it or automation is still
moving its open pull requests. There is no column for a
pull request that cannot move on until a person acts — CI fixes exhausted, or
CI blocked: Claws moves the issue to Blocked with a reason naming the pull
request, and back out on its own once the pull request is back in the normal
flow. Blocked holds only issues that need a person. An issue Claws parked only
to wait on other work in flight — open pull requests it must see merged, or
issues it depends on — sits in Queued instead, a column Claws sets of the
building group: its card names what it waits on, as a Blocked card names its
reason, and carries no "Needs a human" chip. When that work lands the issue moves
on by itself; when a dependency instead needs a person (a pull request closed
unmerged), the issue moves to Blocked. An operator's own Blocked reason always
puts the issue in Blocked. The issue page and the session issue reads name the
same column, and the issues list labels such a row Queued. At every width only the columns waiting on the operator —
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
meant "plan awaits review" on an issue and "merge awaits review" on a pull
request (the label is now retired, #clw_01M5VW14RKAAGS6VZ5PCKQXB9F). A single PR open column likewise hid the pull requests stuck on a person
among the ones automation was still moving, and a large-screen board with every
column open buried the few cards that need the operator among the many that do not.
Blocked mixed issues needing the operator with ones Claws releases by itself once
their dependencies land, which made the latter look like they needed attention and
inflated the Needs-you count (#clw_01M64CH10AK2PKH1JDGTB3FBMJ).

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
PRs lists, Backlog groups, the repository page and an issue's repository chips, the Sessions page's repo choosers, the ended-session page, the New Issue form's repo list and the Usage and Jobs repo tables —
carries a small square beside its name: the avatar its `claws.json` declares, or a
neutral initial when it declares none or the image cannot load. Claws files one
issue in each monitored repository that has not declared one and closes it once the
repository does; what the avatar is and how it is made is the repository's choice. Pickers show the avatar beside a selectable, visible name. Board cards show only the avatars, one for each repository the
issue names, together at the right of the card's header, apart from the automerge toggle in its top-left corner, and a hover or tap shows
the name.
Left as text on purpose: the Board repo filter `<select>` (a native select cannot show an image), the Dashboard and Jobs-matrix running-task cells (client JS re-renders them from JSON that carries no avatar data), `repo#N` PR references, and the browser tab title.
**Why:** operators watching several repositories should recognise them at a glance
rather than by reading names; the operator reported the board's name pills as noise.

### Order the Sessions page's repo choosers alphabetically

The Sessions page's single and multi repo choosers list repositories alphabetically by
short name, ignoring case, in the same order on every load. The pre-selected repository
is still the most recently active one.
**Why:** scanning a long list for a repository is predictable only when its order does not
shift as tasks run.

### Keep board columns readable at every window width

Board columns never overlap each other at any window width, including a desktop-width window,
and the board carries no standing explanatory paragraph beneath it.
**Why:** the operator reported columns overlapping on a desktop, and called the board's long
how-it-works blurb useless; column hints and tooltips carry the detail where it is needed.

### Let a long board column scroll on its own

From tablet width up, a column whose cards do not fit scrolls inside itself under its heading;
the page, the group headings and the other columns stay put, and a refresh keeps each column's
scroll position. Short columns and the phone's stacked sections look as before.
**Why:** the operator wanted long columns to scroll independently rather than dragging the whole
page (#clw_01M5HNAGVSJ97RNC0850YWCGEA).

### Make the Reauth page's Claude authorization link open the real URL

Tapping the Claude authorization link on the Reauth page opens the actual authorization URL in a
new tab, as Copy URL already supplies it.
**Why:** the link opened a 404 on the dashboard while Copy URL worked, blocking reauthorisation
from a phone (#clw_01M5JKWYB39GBPTFAWZNX2AFP1).

### Reauth refreshes and holds each Claude account separately

The Reauth page shows one section per Claude account (Claws database state, see the next
requirement) with its token presence,
auth-expired state, current usage-limit hold and per-tier holds, its own Start login (which
refreshes only that account's token and clears only that account's holds) and its own Clear
cooldown. A usage limit holds only the account that hit it, and runs continue on another account
before falling back to Codex or OpenCode or failing a pinned run; the Claude provider counts as
rate-limited only when every account is held, which the Provider cooldowns table reports as
"k of N accounts held".
**Why:** the operator runs two Claude Max subscriptions, and one account's limit held the whole
Claude provider down while the other had headroom (#clw_01M5YC60E7CR7G1N3ZEHHFHSE9).

### Manage Claude accounts on /reauth with no config or env change

The set of Claude accounts and each account's OAuth token are Claws database state. The Reauth
page has an **Add account** control (id and optional label) that gives the new account its own
section with Start login at once, and each section can rename its account or remove it. An
account's login stores its token in Claws state, and every Claude path — the CLI child, pi's
Anthropic provider, completion-API runs, agent pods and the session `claude-login` capability —
reads it from there when it needs it, so a session started from the web tier right after a login
gets the new token, and restarts and rollouts keep accounts and tokens with no env file or
`claws-auth` Secret entry. Removing an account clears its token, holds and auth-expired state;
past tasks keep their recorded account. Pages and API responses show only whether a token is
present, never the token. The first boot of the release imports the accounts and tokens config
and env used to hold, after which `claudeAccounts` and `CLAWS_CLAUDE_ACCOUNTS` are no longer read.
**Why:** with a second Max account logged in, the operator found no way to add it on `/reauth`:
the account list lived in config and env and each token in an env key and Secret, so adding one
needed a config or env change and a rollout, and a fresh login reached new sessions only after the
web tier restarted (#clw_01M5Z3N6TRQVWVYZCFK56YVN8J).

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

### Collapse long runs of inline images in an issue's request

When an issue's request embeds more than 3 images, the issue page shows them collapsed behind a count ("N images") instead of rendering each full width. One action expands them, and each image opens at full size; a request with 3 or fewer images shows them inline as before.
**Why:** an issue with 55 inline photos pushed the plan and discussion off the page.

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

### Serve one-shot completions to managed services

A service Claws manages can get a single LLM completion from Claws over an authenticated endpoint, choosing provider and model or taking the defaults. The run has no tools, checkout, MCP servers or Claws secrets. It is capped in size, time and per-caller concurrency, counts toward the existing per-provider usage tracking and limits under the calling repo, and fails with a retryable error rather than hanging when a provider is at its limit. The caller's token reaches only this endpoint. See [completion-api.md](../completion-api.md).
**Why:** the operator has no direct Anthropic API access, only the subscriptions Claws already logs into. Bundling an agent CLI and a copy of that login into each service, as growth-engine's social drafter would otherwise need (#clw_01M5NF2W61G3G3V8JZ2H6EF1YY), spreads the credential and bypasses Claws' usage tracking and limits (#clw_01M5P9TX7MX0VACA03DGEJJ1XD).

### Show each blog post's publication status and filter to drafts

The Blog page shows every post's latest status — Published, Draft, Awaiting merge (linking its PR) or a merged/closed PR, plus Unpushed edits — and can filter the list to unpublished posts. A post is published when it is in the blog repo's content directory and its front matter has no `draft: true`; PR state is read live, never from the stale "pushed" record.
**Why:** a bare dash for every already-published post left the operator unable to tell published posts from drafts and posts in review, and unfinished posts were buried in the back catalogue (#clw_01M5Q8SNBRTSNJ68VXZ0EDBX5H).

### List each blog post once, with its drafts under it, and never let a stale saved draft hide repo content

The Blog page shows one entry per post, matched by file name without its leading `YYYY-MM-DD-` date, so a draft whose date changed before publishing nests under the published post. Under each entry go its drafts — drafts saved in Claws and open pull requests on the blog repo — each with its status, last-edited time and View diff, Edit and (for a saved draft) Discard, which asks for confirmation and never changes the repo. A recorded PR that cannot be found reads "not found", not "closed". A saved draft whose PR merged, closed or cannot be found, or whose repo file changed since it was saved, is Stale: it does not count toward Drafts, and the editor shows the repo version with the stale draft offered separately. The All and Drafts counts count posts; a post is a draft when its repo file is `draft: true` or it has a live saved draft or open PR.
**Why:** saved drafts were never cleared, so 99-day-old leftovers from GitHub-era PRs inflated the Drafts count, showed as separate "(new)" rows and silently replaced newer merged repo text in the editor (#clw_01M5SJBPQZ3PRD3A390XM9ZJQ0).

## Non-goals & rejected ideas

- Do not make explanatory text or multi-row dashboard chrome displace an interactive terminal on compact touch screens; a single-row nav is acceptable.
- A native iOS client is not required where the supported web app can provide the needed access.
- Claws does not automate Home Assistant upgrades: on thinkcentre, Core and service versions follow nixos-config's `flake.lock`, and device firmware (Z-Wave, ZHA, Shelly, ZBT-2/SkyConnect radios) is updated by hand (#clw_01M501MVRCMQZ2QXMN410V25DB).
- Claws does not monitor Home Assistant (operator decision 2026-10-15): the deploy, backup, battery, repairs and bin-day monitors were removed (#clw_01M504VV1NB5YB9QNP4KAMQKK7). Agent access to HA is unchanged; replacement monitoring is deferred to #clw_01M5034BWAT7379RB9THG0KJCR.
- Claws does not manage Home Assistant configuration: the area and energy registry reconcilers run in home-assistant-config's own deploy on thinkcentre (#clw_01M504V87DDSKQFN9694J0H0SF). Agent access to HA is unchanged.
- Claws does not source purchases, process comments or keep a `[shopping]` tracking issue: each repo publishes its own shopping pages and sources purchase options while delivering its issues (#clw_01M533FKWN23CRBXXRTDABBHAH).

## Open questions

- Comment moderation for the blog remains proposed and is not a current integration.
