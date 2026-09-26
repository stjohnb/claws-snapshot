# Interactive sessions

**Reference.** Read this when changing interactive agents, capabilities, terminal
pages, session persistence, or session usage. Read [automation lifecycle](automation-lifecycle.md)
instead for headless issue and pull-request automation.

## Problem

Interactive sessions must remain useful across deployments while exposing only the
access and interface controls necessary to complete operator-directed work.

## Users

Operators start and reconnect to sessions; agents need usable terminals, contextual
access, and reliable diagnostics without gaining unattended authority.

## Requirements

### Preserve interactive sessions across routine rollouts

A rollout must leave a live session's process, scrollback, checkout, working directory,
and uncommitted work available for reconnection.
**Why:** a deployment must not discard an operator's active work.

### Isolate Kubernetes sessions one pod at a time

Kubernetes-hosted sessions use an independent pod per session, not a shared SSH runtime,
and failed lifecycle API calls must report failure rather than end or delete a session.
**Why:** the rejected shared-runtime design made session state ambiguous and unsafe.

### Preserve user changes when seeding shared shell defaults

Kubernetes service and session homes use shared shell defaults from
`nixos-config`'s `claws-session-shell` image (#3169), solely as a source of
dotfile defaults rather than the Claws runtime. Defaults seed create-only from
`/etc/skel`; edited `.zshrc` and `.ssh/config` files and session PVC state must
survive restarts, End and Revive. SSH capability grants add only Claws-owned key
symlinks and must not hide the seeded or user-edited `~/.ssh/config`.
**Why:** shared defaults must not overwrite an operator's persistent shell configuration.

### Derive Mac SSH capabilities from configured runners, not a separate list

SSH session capabilities for the macOS Actions runners are derived from the same
`macRunners` configuration `mac-runner-waker` already SSHes into, not a separate
hardcoded host list, and a Mac disabled or removed there loses its capability without
a restart (#3138, 2026-09-22).
**Why:** a second, hand-maintained list of Mac hosts would drift from the one
`mac-runner-waker` actually uses.

### Show real Kubernetes session startup progress until attachable

Creating or reviving a Kubernetes session must redirect to its terminal page once the
session row and Kubernetes objects exist, then show live Claws/Kubernetes startup
state: object creation, scheduling/storage/image, repository checkout, terminal server
readiness, and failure or ended state. Show elapsed time without fabricated percentages
or secret-bearing logs (#3198, 2026-09-18).
**Why:** operators must be able to see startup progress instead of waiting on a blocked
form submit.

### Keep a dead session's exit status and last output visible

When a session's process ends on its own, its terminal page stays on the last output
instead of navigating away, and the session records the process's real exit code so a
crash reads as failed rather than a normal quit. The final output stays viewable from
the sessions history after the session's pod or tmux session is gone (#3311, 2026-09-23).
**Why:** a Codex session that crashed on every launch took three launches to diagnose,
because each crash looked like a clean exit and its error output was lost.

### Accept session attachments without lifetime quotas

Long-running sessions must keep accepting attachments that satisfy the per-file upload
limit, without a per-session file-count or total-byte cap. Underlying session storage
and normal session cleanup bound storage consumption.
**Why:** attachment limits must not prevent an ongoing session from receiving new work.

### Grant session capabilities by default only when they are relevant

Session creation preselects the capabilities the operator last submitted for that exact
repository combination — one repository or several — with a static per-repository map only
as the seed for a repository never used before; a multi-repository combination never used
before starts without repository grants. Each new submission replaces the remembered set for
its combination, and the server still grants only what the operator submits.
**Why:** irrelevant infrastructure access is noise and can create ambiguous credentials.

### Show automatic capability grants instead of hiding them

The session-create form lists every configured capability, including ones granted
automatically — the unconditional `cross-repo` baseline and the Forgejo-hosted-repo-only
`forgejo` grant. When a capability is forced for the selected repo(s) it renders checked
and disabled with the reason; when it is only conditionally automatic and isn't forced for
the current selection, it renders as an ordinary opt-in checkbox the operator can tick.
**Why:** an operator must be able to see every credential a session will hold before
creating it.

### Require human approval for additional live capabilities

An agent may request a capability during a session, but every additional grant requires
an operator decision and must reach a running or waiting agent without restart.
**Why:** agents need to recover from missing access without gaining auto-grant authority.

### Offer every configured capability that can be delivered mid-session

A running session's additional-grant controls must list every configured capability, each
in one of three states: already held (shown as granted), grantable now or on the next
resume, or fixed at launch (shown disabled with the reason, e.g. "start a new session").
Launch-default or create-form hiding must not by itself prevent later operator approval.
An SSH host can be granted to a `k8s-pod` session; when the pod launched without SSH keys
the grant is recorded and takes effect once the session is resumed, and the grant status
says so. The control never hides the rest of the registry, even when nothing is left to
grant (#3322, 2026-09-23).
**Why:** operators need to rescue sessions that discover a missing access path, including
Forgejo git/API or SSH access, without losing context, and must be able to tell a held
capability from one that needs a resume or a new session.

### Keep default runtime diagnostics read-only

Sessions may inspect service health, scheduling, logs, queue and processing state by
default, but cannot trigger jobs, alter configuration, deploy, write data, or reveal secrets.
This applies to supported local sessions and Kubernetes Claude/Codex/OpenCode agent
pods when `CLAWS_SESSION_MCP_URL` is configured, using per-session bearer tokens
rather than service credentials. Filing or commenting on an item in Claws' own
issue tracker is the one allowed write: a session could always do this by
shelling out to the forge's own CLI, so a tracker tool that does the same
thing natively is not a new capability.

The general rule: a session may read every Claws entity by default, unless that entity
holds something sensitive — secrets, credentials, or another session's capability grants.
This includes Claws-native issues, their comments and their plan history, so a session can
review a posted plan before applying **Refined** and see what feedback is already on an
issue before adding more. Tracker reads are not scoped to the session's own repos, because a
session can already read any managed repo's issues through the forge's CLI or API; scoping
the tracker tools would add complexity without making anything safer.
**Why:** diagnosis should be evidence-based without turning ordinary sessions into operators, and read access that a session could already get another way is not worth gating.

### Keep terminal controls usable on touch devices

The terminal must remain the primary workspace on phone and tablet viewports, with a
horizontally scrollable keybar whose controls fire on release and include utility keys. A
voice note must not re-prompt for microphone permission on every recording on a tablet,
releasing the microphone only when the page is hidden, the session ends, or the control
sits idle.
**Why:** touch users need both room for the terminal and reliable terminal input.

### Account for session cost and context growth

Usage views must include interactive sessions and visibly warn before a live session's
context becomes expensive, retaining unknown cost as unknown rather than zero.
**Why:** operators need to intervene before long sessions quietly consume budget.

## Non-goals & rejected ideas

- A shared always-on SSH runtime is not an acceptable Kubernetes session design.
- Defaulting every capability on for every session is rejected.
- Giving sessions direct `/api/*` access with their session token, instead of MCP tools, was
  rejected: it would need a new auth path on top of the existing `INTERNAL_MCP_TOKEN`/OIDC
  gate, and it would put the token in the session's shell where any command could read it.

## Open questions

- Durable preservation of CLI conversation history outside a session runtime needs a long-term storage decision.
