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
primary content on a tablet, and collapses tables to cards on a phone.
**Why:** operators use the dashboard away from a desktop, on whichever device is at hand.

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
with the issue page's status buttons (including **Mark refined**), and it is stored as one
field on the issue rather than as label checkboxes.
**Why:** a single field cannot hold two contradictory states, and the control applies a
complete, valid state.

### Show the board as the lifecycle's stages, grouped

The board's columns are the lifecycle's stages — Ideas, Planning, Awaiting plan
review, Approved, Implementing, PR open, Awaiting merge, Done, with Blocked and
the Backlog tray — grouped as shaping, building and landing. A column where a
human is needed is marked as such and accepts a drop; a column Claws moves
cards through on its own is derived from the store at render time and refuses
one. Plan review and merge review are separate columns. On a phone the groups
stack and the derived columns fold into their group as a count.
Approved design: [refinements/issue-flow.md](../refinements/issue-flow.md).
**Why:** one In progress column hides three states the operator treats
differently — the implementer running, a pull request cycling through CI and
review, and a pull request waiting for a person — and the same word, Ready,
means "plan awaits review" on an issue and "merge awaits review" on a pull
request.

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

### Show an issue as request, current plan and discussion, and keep every plan version

The issue page shows a Claws-native issue as its initial request, its current plan and its
comments, each a collapsible block, with the plan split into its sections and every earlier
version of the plan still viewable. Pages that list many issues offer the plan collapsed on
each issue. See [issue-tracker.md#plans](../issue-tracker.md#plans).
**Why:** the plan is what the operator reviews and approves; once a refinement rewrites it
in place the reasoning it replaced is lost, and a plan buried in a flat comment thread is
hard to find, read section by section, or compare with what came before.

## Non-goals & rejected ideas

- Do not make explanatory text or a full dashboard navigation bar displace an interactive terminal on compact touch screens.
- A native iOS client is not required where the supported web app can provide the needed access.

## Open questions

- Comment moderation for the blog remains proposed and is not a current integration.
