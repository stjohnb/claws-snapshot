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
A session whose process dies during startup, before its terminal server can report an
exit, still shows the process's fatal log text in the startup banner, status cell and
ended-session page, captured from the pod's termination message before routine cleanup
deletes the pod (#clw_01M3HHA3KY0AMHDMH6C2F2X34Z, 2026-09-27).
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
issue tracker is allowed: a session could always do this by shelling out to the
forge's own CLI, so a tracker tool that does the same thing natively is not a
new capability. The only other writes are the native-issue writes below.
They are a new capability, so they are held to stricter terms.

The general rule: a session may read every Claws entity by default, unless that entity
holds something sensitive — secrets, credentials, or another session's capability grants.
This includes Claws-native issues, their comments and their plan history, so a session can
review a posted plan before applying **Refined** and see what feedback is already on an
issue before adding more. Tracker reads are not scoped to the session's own repos, because a
session can already read any managed repo's issues through the forge's CLI or API; scoping
the tracker tools would add complexity without making anything safer.
**Why:** diagnosis should be evidence-based without turning ordinary sessions into operators, and read access that a session could already get another way is not worth gating.

### Let a session pass a native issue's gates only through session-only tracker tools

An interactive session may move a native `clw_…` issue through the human gates the
operator is driving it through: apply or remove **Refined** and **Automerge**, set
**Blocked** and **Priority**, and promote the issue out of Ideas. It may also read and set
the issue's per-phase model plan, and take the issue page's other actions: close it as
completed or not planned and reopen it, edit its title and body, set its repos to managed
repos, apply or remove the Labels form's other labels (e.g. **Claws Ignore**, **Plan:
Deep**, **Use Codex**), move it to any Status column, and clear a pull request's recorded
manual action once the step it names is verifiably done — the one PR-state field a session
may write, since removing the **Manual Action** label on the forge does not clear the
record the auto-merger blocks on. Attachments are not offered: a
session's files live in its own runtime, and the MCP transport has no file channel to the
server. Unlike filing and commenting, this is a new kind of write. A native issue has no forge copy, so a session has no other supported way to do it.
These writes must be:

- MCP tools registered only for an interactive session, never for a headless agent, so
  automation cannot approve its own work;
- authenticated by a credential scoped to that one session, never the shared internal
  token or an agent pod's own token — both of which every agent holds, so accepting either
  would let automation grant itself the same approval through the HTTP route directly. Only
  the k8s-pod backend's `/mcp/sessions/:id` endpoint has such a credential today; a
  local-tmux session is refused until it has one too;
- held to the dashboard's own checks: a live, open, non-shadow native issue with a primary
  repo Claws manages, except where the dashboard itself allows otherwise (reopening needs a
  closed issue, and closing or assigning repos works on an unassigned one; for a manual-action
  clear, a pull request in a managed repo with a Claws record that holds one). Like tracker
  reads, they are not scoped to the session's own repos;
- recorded as `session:<id>` wherever the store names an approver (merge approval,
  requirements approval), plus a Claws-marked comment on the issue (or, for a cleared manual
  action, the pull request) for every change, so the
  issue's history tells a session's change apart from an operator's click.

A session must never change Claws state any other way. It must not reach the database,
and it must not call a dashboard route.
**Why:** sessions driving `/ship` on native issues had to stop and ask the operator to
click Refine. One session wrote model-plan rows straight into the database to route around
a provider limit (#clw_01M3BWP83BQRXE06NWW1GKYT2S, 2026-09-25 and 2026-09-26). A session
that found a PR's manual step already done could only remove the forge label, which left
the PR silently blocked until it was merged by hand (#clw_01M3M5ED6YNE8FTNE3QR8JR3XX). On
2026-09-28 a session asked to close a finished native issue had to send the operator to the
dashboard, since only the gates had tools (#clw_01M3KZW7Y4RVDPVZG22HG8ET1M).

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

### Review KiCad hardware changes from CI artifacts in any managed repo

A session in any managed repo must be able to review a KiCad hardware pull request —
schematic and board views, DRC/ERC reports, netlist and BOM diffs — using only the
evidence in that repo's own PCB CI artifact, with no per-repo installation and no local
rendering. The bundled `/pcb-review` skill is this: it resolves a target PR, retrieves
its CI artifact, and works through a fixed checklist, available in every session in
every managed repo the same way `/postmortem` and the other bundled skills are. The
review is read-only: it must never invoke KiCad tooling, never start a long-running
process, and never post to the pull request unless the operator explicitly asks. On a
Forgejo-hosted repo the artifact reaches the reviewer as a PR attachment rather than a
run artifact, because Forgejo has no artifacts API; the skill never shells out to `gh`
there.
**Why:** the automation host has neither Nix nor `kicad-cli`, so nothing can render KiCad
output locally; without a shared, bundled review skill, each hardware repo would
otherwise reinvent the same artifact-retrieval and checklist logic on its own.

### Publish to the fleet pages host only through an explicit pages grant

A session granted the `pages` capability must be able to publish a local directory to
the private fleet pages host at the conventional `/<repo>/<kind>/<ref>/<sha8>/` path
(`<kind>` one of `pr`, `issue` or `docs`) and learn the resulting URL. A publish whose
directory has no root `index.html` is rejected, and a successful publish removes every
other SHA under the same `<repo>/<kind>/<ref>/`. `pages` follows the same default-deny,
explicit-grant and live-grant rules as every other capability, is unavailable when the
pages host is not fully configured on the deployment, and a session without the grant
has neither the host's S3 endpoint nor its credentials (#clw_01M3J52H0H9WSH3GTSY87ZY351,
2026-09-28).
**Why:** least privilege — the same rule as every credential-backed capability: write
access to a shared host is only for sessions the operator chose to give it. Garage does
not list directories, so a prefix without `index.html` is unbrowsable, and stale SHAs
would otherwise accumulate forever.

## Non-goals & rejected ideas

- A shared always-on SSH runtime is not an acceptable Kubernetes session design.
- Defaulting every capability on for every session is rejected.
- Giving sessions direct `/api/*` access with their session token, instead of MCP tools, was
  rejected: it would need a new auth path on top of the existing `INTERNAL_MCP_TOKEN`/OIDC
  gate, and it would put the token in the session's shell where any command could read it.

## Open questions

- A session's gate approval (Refined, Automerge, promotion) is recorded as `session:<id>`
  for now. It is still open whether it should instead resolve to the operator present in
  the session, to meet [Verify who approved, not just that an approval exists](automation-lifecycle.md#verify-who-approved-not-just-that-an-approval-exists)
  ("not Claws itself").
- Durable preservation of CLI conversation history outside a session runtime needs a long-term storage decision.
- A local-tmux session has no per-session MCP credential, so it does not get the native-issue
  write tools (`claws_set_issue_label`, `claws_promote_issue`, `claws_set_issue_model_plan`,
  `claws_set_issue_state`, `claws_edit_issue`, `claws_set_issue_repos`,
  `claws_set_issue_column`) at all today (#clw_01M3BWP83BQRXE06NWW1GKYT2S) — only a k8s-pod session
  does, through `/mcp/sessions/:id`'s existing per-session bearer. Minting and verifying one
  for local-tmux sessions too (analogous to the pod token, but for a host tmux session) is
  unscoped work.
