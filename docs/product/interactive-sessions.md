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

### Tell a session that outlived a deploy its tool list changed

An agent lists its MCP tools once, at launch. When Claws was upgraded since a session
launched or last resumed, its `/mcp/sessions/:id` endpoint sends
`notifications/tools/list_changed` once. Tool results and the session's dashboard page
carry no notice to restart for new tools.
**Why:** the restart warning was noise that was rarely useful.

### Run interactive sessions only as Kubernetes pods

Every interactive session runs as its own Kubernetes pod; nothing in Claws starts,
recovers, reaps or resumes a session on the Claws host. `CLAWS_SESSION_BACKEND` is unset
or `k8s-pod`, and any other value, including the removed `local-tmux`, stops the service
at startup with an error naming the only supported value. Sessions that ended on the old
host tmux backend stay in the sessions history with their title, repos, timing and last
output, but cannot be resumed: the list offers no Resume, the ended-session page says host
sessions can no longer be resumed, and a resume request is refused with a conflict rather
than an error page. The tmux inside each session pod, which the dashboard terminal
attaches to, is part of the pod runtime and stays.
**Why:** production had run every session as a pod since the cutover, with no tmux server
on the Claws host (checked 2026-10-09), yet every session change still had to keep the host
backend's grants, revokes, grant delivery, resume, uploads and MCP tokens working and
tested (#clw_01M4H2794K7YJFSBH30Y83DVF4).

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
Host keys for the LAN `ssh:*` hosts are pinned image-wide at
`/etc/ssh/ssh_known_hosts` from the repo's `deploy/ssh-known-hosts`, never scanned
at start and never `accept-new`, so a first non-interactive ssh to a granted host
succeeds and a changed key fails closed; Claws never writes `~/.ssh/known_hosts`.
**Why:** shared defaults must not overwrite an operator's persistent shell configuration.
Without pinned keys, BatchMode ssh printed "Host key verification failed" and agents
falsely reported a changed ryzen host key (#clw_01M5348XZ05D0YC15YXBGXHV8M, 2026-10-16).

### Derive Mac SSH capabilities from configured runners, not a separate list

SSH session capabilities for the macOS Actions runners are derived from the same
`macRunners` configuration `mac-runner-waker` already SSHes into, not a separate
hardcoded host list, and a Mac disabled or removed there loses its capability without
a restart (#3138, 2026-09-22). The capability's advertised connection resolves
through the same LAN alias table, so it works from a session pod without mDNS.
**Why:** a second, hand-maintained list of Mac hosts would drift from the one
`mac-runner-waker` actually uses. The create form lists the Mac SSH hosts (unticked,
never pre-ticked) for the Mac-runner repos rather than only behind "Show all
capabilities", because they were otherwise effectively undiscoverable (#clw_01M4JPAE7296RZN7FCXGM3MA7C, 2026-10-10).
**Why:** a capability the operator cannot find is a capability they cannot request.

### Offer SSH to the production cluster nodes through a tailnet jump host

Each production cluster node (`prod-cluster`, the k3s control plane, and `prod-data`,
the k3s agent holding the Postgres volume) is its own `ssh:*` capability, labelled with
its role, requested and approved like any other SSH host and listed unticked for
`production-infra`, `namey` and `bonkus`. The nodes are tailnet-only and pods are not
on the tailnet, so the session reaches them with `ssh -t nas tailscale ssh root@<node>`
(`ryzen` when `nas` is off), where `<node>` is the node's current tailnet name from
configuration (Tailscale suffixes it on every rebuild, e.g. `prod-cluster-11`). On the
node, kubectl runs as `k3s kubectl`. Grant and revoke reuse the shared SSH key machinery, so
every `ssh:*` grant shares one key set: a session holding any SSH host can technically
make the same hop, and revoking one host while another is held leaves the keys in place.
No standing or automatic grant exists, and headless runs get none.
**Why:** least-privilege access to production (`docs/PRODUCT.md#goals`) needs an
explicit, operator-approved, per-session grant rather than shared credentials.

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
the sessions history after the session's pod is gone (#3311, 2026-09-23).
A session whose process dies during startup, before its terminal server can report an
exit, still shows the process's fatal log text in the startup banner, status cell and
ended-session page, captured from the pod's termination message before routine cleanup
deletes the pod (#clw_01M3HHA3KY0AMHDMH6C2F2X34Z, 2026-09-27).
**Why:** a Codex session that crashed on every launch took three launches to diagnose,
because each crash looked like a clean exit and its error output was lost.

### Drop an ended session from the active list at once

When an operator ends a session from the sessions list, the active list stops showing it
within about a second, without a reload. A session whose process exits on its own is
ended as soon as its pod reports the exit; the periodic reconcile pass only covers a pod
that dies without reporting. An open sessions list refreshes itself every 5 seconds while
its tab is visible, so another tab drops the session too. If End fails, the session stays
listed as active and the error is shown to the operator. Ended sessions stay in the
sessions history as before.
**Why:** an ended session lingered as "Running" for up to a reconcile interval or a manual
reload, which made End look as if it had not worked (#clw_01M52FEC8QSM9P57WWSEBYFB7D, 2026-10-16).

### Accept session attachments without lifetime quotas

Long-running sessions must keep accepting attachments that satisfy the per-file upload
limit, without a per-session file-count or total-byte cap. Underlying session storage
and normal session cleanup bound storage consumption.
**Why:** attachment limits must not prevent an ongoing session from receiving new work.

### Let a session present generated files for download

An interactive session can publish a file it generated — a script, an image, a report —
with the session-only `claws_publish_file` MCP tool, and the user sees it on that
session's dashboard page with its name and size and a Download control; allowlisted
images (PNG, JPEG, GIF, WebP) also open inline. A download is byte-identical to what the
session published and keeps its filename. Names are unique within a session: a name that
was already published gets a numbered suffix (`deploy.sh` becomes `deploy-2.sh`) and the
tool response reports the final name and that it changed. Agents are told, in the tool
description and the session prompt, to give each revision a new, distinct, descriptive
name. Each file shows its publish time, and the newest of a same-named family is marked
Latest. The user can collapse the list on the session page and restore
it; collapsing never removes a file, and files published while it is collapsed are flagged
as new. Claws copies the file out of the session's
runtime when it is published, so it stays downloadable after the pod or runtime restarts
and after the session ends, until the session is deleted or pruned from history, which
removes it too. Downloading needs the same dashboard login as the session page, and a
file is served only under its own session's URL. A file must be inside the session's
home directory; one over the 10 MB per-file limit is refused with a message naming its
size, and a session whose pod predates the tool is told to end and revive. Any session
with the `claws-state` MCP server can publish; headless agents, PRs and forge issues are
not covered, and there are no public links
(#clw_01M4QNRZK3XVZ8AJRJ2BPR01QB, 2026-10-12).
**Why:** a session's output otherwise lived only in its own runtime, so a user could not
retrieve a generated script or image from the dashboard.

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
an operator decision and must reach a running or waiting agent in the same session, never
by making the operator start a new one. Most grants reach it without any restart. A
capability whose tools can only be attached when the agent starts — `browser` on Claude,
whose Playwright MCP server is loaded only at launch — instead restarts the agent process
with its conversation kept, in the same session; the operator's page says the agent is
restarting and continues where it left off, and once it is back Claws types a notice telling
the agent it now holds the capability (#clw_01M4RASNVDKH2YBHZMGR0SM0RA, 2026-10-12). On a
`k8s-pod` session a grant is usable within seconds: after updating the session's Secret,
Claws forces the pod to re-sync it rather than waiting the kubelet's 1–2 minutes, and only
falls back to that schedule when it lacks the RBAC to do so. Granted environment variables
are loaded into every new shell the agent runs — Claude, Codex, OpenCode and pi alike — with
no sourcing step. Whether the operator approves a request or uses the Grant control with
nothing pending, Claws itself types a one-line notice into the agent's terminal unless a
waiting agent has already collected the grant, so no browser tab has to be connected; the
notice tells the agent it now holds the capability and must not request it. Neither the
notice nor `claws_request_capability` calls a grant granted before the pod confirms it is
usable: until then the tool reports a distinct `landing` state and keeps waiting. Pending
requests and denials are stored, so after a Claws restart a pending request is still shown
and can be approved or denied, reaching the agent as before, and a denial still stands
(#clw_01M4H27M8P02VT70091MBG0E4F, 2026-10-10). A pod launched before this keeps the older
behaviour: it sources the granted file by hand and the operator is asked to tell the agent.
**Why:** agents need to recover from missing access without gaining auto-grant authority,
and a grant that arrives minutes late, needs a remembered sourcing step, never reaches an
agent that stopped waiting, or vanishes on a restart does not actually unblock the work.

### Offer every configured capability that can be delivered mid-session

A running session's additional-grant controls must list every configured capability, each
in one of three states: already held (shown as granted), grantable now or on the next
resume, or fixed at launch (shown disabled with the reason, e.g. "start a new session").
Launch-default or create-form hiding must not by itself prevent later operator approval.
An SSH host granted to a running `k8s-pod` session is usable within seconds, without a
resume, restart or new session, even when the pod launched without SSH access, and the grant status shows it
held rather than waiting for a resume; a held SSH host can be revoked the same way, and the
session loses the shared keys once no SSH host is left. Only a pod launched before this
behaviour (#clw_01M498646BRDF9F2A2DT21WFQ6, 2026-10-06) records the grant or revoke for its
next resume, and the grant status says so. The control never hides the rest of the
registry, even when nothing is left to grant (#3322, 2026-09-23). `browser` is grantable
to a running Claude agent session, delivered by restarting the agent with its conversation
kept; it stays fixed, shown disabled with the provider's reason, on Codex, OpenCode, pi and
plain shell sessions, which cannot use it, and an agent request for it there is refused. A
session holding `browser` keeps the full `claws-state` tools and can still be granted
other capabilities live; the operator accepted the prompt-injection risk of browsed pages
reaching those tools (#clw_01M4RASNVDKH2YBHZMGR0SM0RA, 2026-10-12).
**Why:** operators need to rescue sessions that discover a missing access path, including
Forgejo git/API or SSH access, without losing context or interrupting the work the grant
unblocks, and must be able to tell a held capability from one that needs a resume or a new
session.

### Offer every headless provider as an interactive agent

Every agent CLI Claws runs headless, pi included, must be offered in the New session
picker with a model choice, running in a session pod, and must get the
same `claws-state` diagnostics and role prompt as the Claude, Codex and OpenCode agents.
A session must be resumable into its previous conversation. Where a CLI cannot attach
extra directories, multi-repo sessions and the `browser` capability are rejected rather
than silently degraded (#clw_01M45NYTP6E5V255CK3ZFCC11J, 2026-10-05).
**Why:** operators need to drive and debug each provider interactively before trusting it
with headless work, and a provider reachable only headless cannot be inspected that way.

### Keep default runtime diagnostics read-only

Sessions may inspect service health, scheduling, logs, queue and processing state by
default, but cannot trigger jobs, alter configuration, deploy, write data, or reveal secrets.
This applies to Claude/Codex/OpenCode/pi session pods when
`CLAWS_SESSION_MCP_URL` is configured, using per-session bearer tokens
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

### Let sessions and agents read Forgejo Actions job logs

Any interactive session or headless agent, whatever coding agent it runs, can read the log
of a Forgejo Actions run in a Claws-managed Forgejo repo, by repo and run number and
optionally a job, through the read-only `claws_forgejo_job_logs` tool. It needs no
capability grant and no operator help. By default it returns the failed steps of the
failed jobs, like GitHub's failed-log view. The output is plain text with ANSI codes
stripped, capped at 60,000 characters, with a marker when it was truncated. The service
reads the log with its own Forgejo token, so no token reaches the session. Values Forgejo
masked as secrets stay masked. Session and agent instructions point Forgejo repos at this
tool, and keep `gh run view --log-failed` for GitHub repos.
**Why:** a session on a Forgejo repo could not see why CI was red, because Forgejo's API
has no job-log endpoint and the web log routes need a browser login. The operator had to
paste error text by hand.

### Give sessions and agents no Kubernetes credentials

No interactive session, headless planner or agent pod receives a kubeconfig or a
ServiceAccount token for the fleet or the production cluster, and no capability grants
one; `kubectl` against either API server fails for lack of credentials. Cluster diagnosis
goes through Grafana once the observability capabilities land
(#clw_01M39MT3EES32JKK0CX95Q9JQ2). Operator cluster work — one-off Jobs, PVC or Secret
deletion — stays with the operator, from their own credentials, or becomes a fleet-infra
migration when it repeats (#clw_01M3EW1TJ5FPD17N8JQSHDJXAJ, 2026-10-06). Claws' own
in-cluster ServiceAccount is unaffected.
**Why:** least privilege — the fleet kubeconfig was `system:masters`, and on 2026-09-26 a
session used it to `kubectl exec` into `claws-0` and write the database directly.

### Let a session pass a native issue's gates only through session-only tracker tools

An interactive session may move a native `clw_…` issue through the human gates the
operator is driving it through: apply or remove **Refined** and **Automerge**, set
**Blocked** (always with a reason) and **Priority**, and promote the issue out of Drafting or Requirements review. Before promoting, it
can read the issue's board stage and its requirements record — the latest version with its approval
state and the earlier versions — and be woken when a version is stored or the issue changes stage. It may also read and set
the issue's per-phase model plan, and take the issue page's other actions: close it as
completed or not planned and reopen it, edit its title and body, set its repos to managed
repos, apply or remove the Labels form's other labels (e.g. **Claws Ignore**, **Plan:
Deep**, **Use Codex**), move it to any Status column, close it as a duplicate of another
open native issue in one call (the **Duplicate** label, then a `claws-duplicate-of:<id>`
marker comment, then a not-planned close, refused when the other issue is the same issue,
unknown, a shadow or closed), and clear a pull request's recorded
manual action — the merge hold the auto-merger blocks on — once the step it names is verifiably done. It may also take the dashboard's and the forge's pull request
recovery actions: re-run the failed jobs of a CI run on a PR's head commit (a named run, or the
newest failed one) on Forgejo and GitHub alike, with no commit pushed and no passed job re-run;
unmark a **Claws Problematic** PR, which returns it to the CI-fix and review flow with a fresh
fix budget as the dashboard's **Unmark problematic** does; and have the Problematic PR
Diagnoser run again even though its earlier report exists, as deleting that report would.
It may post the operator's feedback or ruling on an open pull request in a managed repo, which
Claws' reviewer and review addresser must read as human input although the forge shows it as
posted by Claws' own bot account; the comment names the session and carries no Claws footer,
and only a comment whose id the store records as that session's feedback is read as human.
It may merge a pull request whose merge is already approved, now, through exactly the checks
the auto-merger applies (a recorded manual action or merge hold, CI that is not green, a review
that is not clean for the current head, infrastructure paths, conflicts, a stacked PR or a
re-approval hold each refuse it, with the reason returned); it never records the approval
itself, so with none stored it is refused. Session guidance sends a ready, approved PR to
this direct merge and keeps **Automerge** for approving, or for queuing a PR that is not
ready yet for the auto-merger.
At the operator's direction it may also record a merge approval scoped to one named pull
request, with no **Automerge** on the issue and no approval of the issue's other open or future
PRs, then merge it through the same checks; this works for a PR with no linked native issue.
Without queuing, a refusal withdraws the approval it wrote; queued, the approval stays and the
auto-merger merges that PR alone once its gates pass. An approval already stored is kept as it is.
It may start a new, independent interactive session dedicated to an open native issue (see
"Let a session start an independent session for another issue" below).
It may soft-delete comments on the issue (`claws_delete_issue_comments`) and store a revised
requirements record as a new, unapproved version (`claws_save_issue_requirements`) (see
"Let a session tidy a native issue's discussion" below).
Issue attachments are not offered: a
session's files live in its own runtime, and files flow only the other way, from the
session to the user, through `claws_publish_file` (see "Let a session present generated
files for download" above). Unlike filing and commenting, this is a new kind of write. A native issue has no forge copy, so a session has no other supported way to do it.
These writes must be:

- MCP tools registered only for an interactive session, never for a headless agent, so
  automation cannot approve its own work;
- authenticated by a credential scoped to that one session, never the shared internal
  token or an agent pod's own token — both of which every agent holds, so accepting either
  would let automation grant itself the same approval through the HTTP route directly. Every
  session pod is served from the same `/mcp/sessions/:id` endpoint, so every session gets
  the same tools: each launch and resume mints a fresh bearer for that one session, Claws keeps only its hash, the plaintext lives only in the session's
  private config and env files, and ending the session revokes it. The headless agents'
  stdio MCP server never gets these tools;
- held to the dashboard's own checks: a live, open, non-shadow native issue with a primary
  repo Claws manages, except where the dashboard itself allows otherwise (reopening needs a
  closed issue, and closing or assigning repos works on an unassigned one; for a manual-action
  clear, a pull request in a managed repo with a Claws record that holds one; for a re-run, an
  open pull request in a managed repo whose head commit has a failed run, refusing a run on an
  older commit; for an unmark or a diagnosis retry, a pull request in a managed repo that is
  **Claws Problematic**, and for a retry a diagnosis report newer than the last retry; for a
merge, an open pull request with a Claws record and a stored merge approval that passes every
auto-merger gate; for a single-PR merge approval, an open pull request in a managed repo,
which must then pass the same gates to merge). Like tracker
  reads, they are not scoped to the session's own repos;
- recorded as `session:<id>` wherever the store names an approver (merge approval,
  requirements approval), plus a Claws-marked comment on the issue (or, for a cleared manual
  action or a PR recovery action, the pull request) for every change, with each PR recovery
  action also stored against the session id, so the
  issue's history tells a session's change apart from an operator's click.

A session must never change Claws state any other way. It must not reach the database,
and it must not call a dashboard route.
**Why:** sessions driving `/ship` on native issues had to stop and ask the operator to
click Refine. One session wrote model-plan rows straight into the database to route around
a provider limit (#clw_01M3BWP83BQRXE06NWW1GKYT2S, 2026-09-25 and 2026-09-26). A session
that found a PR's manual step already done could only remove the forge label, which left
the PR silently blocked until it was merged by hand (#clw_01M3M5ED6YNE8FTNE3QR8JR3XX). On
2026-09-28 a session asked to close a finished native issue had to send the operator to the
dashboard, since only the gates had tools (#clw_01M3KZW7Y4RVDPVZG22HG8ET1M). Local-tmux
sessions had none of these tools at all until they moved to the per-session endpoint, and
closing a duplicate by hand took three writes that a session could leave half-done or
without the marker Claws reads duplicates from (#clw_01M45W7WJF4SMWEQ8J15RPJ4Y2).
**Why:** on 2026-10-08 an approved Automerge PR in St-John-Software/electronics (#14) waited
about 20 hours on one transient infra failure that only a human click re-ran, since Forgejo's
API has no re-run endpoint and an empty commit re-runs two 45-minute PCB jobs; another (#12)
needed **Unmark problematic** on the dashboard, and its diagnosis could not be retried after
the diagnoser failed on unreadable job logs (#clw_01M4DQW4N7DJT8WHTCSV3NBZSD).
Session feedback goes through this tool rather than a forge comment because a session
posts to the forge as Claws' own bot account: Claws drops every footer-less comment by
that account so a token holder cannot forge human instructions (#3225), so the operator
ruling a session posted on electronics PR #12 (issuecomment-4047) could not be read as human.
**Why:** sessions applied **Automerge** to green, approved PRs and waited up to about three
minutes for the auto-merger, because the guidance preferred the gate and gave them no merge
that ran Claws' checks; the direct merge is recorded as `session:<id>` in the store and in a
comment on the PR, so the PR's history shows whether a session merged it or queued it
(#clw_01M4XFRSGNP87QVW0N1W5KN0V4).
**Why:** on 2026-10-15 the operator told a session to merge nixos-config#24 once CI was green,
but the only approval a session could record was **Automerge** on the issue
(#clw_01M34R5RDGCPK8WVC3MNG183NZ), which would also have approved home-assistant-config#13,
held until a hardware cutover; the session could not act, and the operator merged it by hand
in Forgejo (#clw_01M5022YK7Z2V63775Y92B59P3).

### Let a session tidy a native issue's discussion

An interactive session may tidy a native issue's comment thread. It soft-deletes the
comments the operator confirms in chat with `claws_delete_issue_comments`, in bulk: each
deleted comment leaves the issue page and everything Claws agents read, its row is kept with
`session:<id>` and the time recorded, and every deletion is a `comment` entry in the
issue's History as well as one Claws-marked audit comment per call. The call refuses the
current plan comment, the latest requirements comment, and any id that is unknown, on another
issue or already deleted, and one refusal deletes nothing. It does not require a new
requirements version first; the session's judgement, confirmed by the operator, decides
what goes. Deleting never re-plans or queues work.

Before deleting, the session may fold still-relevant substance from the comments
(constraints, decisions, "don't do X") into a revised requirements record with
`claws_save_issue_requirements`. That version is stored unapproved and recorded in History;
the tool never approves it, and it is refused while a design change awaits re-approval.
Approval goes through the existing paths — Requirements review, then promotion on the page or
by the session on the operator's explicit say-so — and approving a changed version re-plans an
issue that has a plan. An issue still in Drafting or Requirements review applies its usual
auto-promote policy to a session-saved version.

Whether to re-plan is the operator's per-run choice: keep the current plan, or start a fresh
re-plan against the current approved requirements with `claws_set_issue_column` and
`planning`, which is refused when the issue would land in a derived column (for example while
a PR is open). The bundled `/tidy-issue` skill walks a session through the same steps every
time: read the issue, classify each comment with a reason, optionally save a revised record,
propose the deletion list and wait for the operator's yes, delete, then keep the plan or
re-plan as asked.

**Why:** long-lived issues bury the plan under stale back-and-forth, superseded
reassessments and status noise (#clw_01M34R5RDGCPK8WVC3MNG183NZ), and a session that has read
the whole thread judges what is still relevant far better than fixed rules such as "no 👍
means unaddressed"; every action lands in History so the tidy-up stays auditable
(#clw_01M5001TVYQ36RKG67GSYE64K8).

### Let an explicit /ship pass routine gates and stop only for human decisions

An explicit `/ship <scope>` authorises the session to pass the routine gates for the items in that scope without asking: promote a requirements record, apply **Refined** to a sound plan, and apply **Automerge** once CI and the Claws review are clean. The session still checks requirements against the issue and its comments and the plan against the issue and the current code, and corrects an unambiguous gap through feedback comments. It stops and asks only when requirements or plan contradict the issue unclearly, an item would widen scope, a **Claws Problematic** PR or blocked CI can't be cleared with the recovery tools, a destructive or irreversible manual action or a post-merge cluster action is involved, an OpenTofu/Terraform PR needs a human merge, or the operator asked for a plan or requirements review. A passed gate does not end the turn. Bare `/ship` still proposes and confirms before acting.

**Why:** On 2026-10-14 in fleet-infra, `/ship` on #clw_01M4XEQDJTKMY0JDHX6ZHHRQEC stopped to ask "Shall I promote it?" over a record that matched the issue exactly; the operator expects to be brought back only when necessary (#clw_01M4XFXVQS716T624Z7NV41CG4).

### Let a session start an independent session for another issue

From a running interactive session, an agent (the bundled `/new-session` skill) may start a new
interactive session through the session-only `claws_start_session` tool, either dedicated to an
open native `clw_…` issue or, when no issue exists for the work, with no issue at all, held to
the session-only write rules above: the session's own bearer, the dashboard's own checks, no
database access and no dashboard route. A forge issue is refused. The new session must:

- begin with the issue in its system prompt — title, dashboard URL, body, latest plan and the
  caller's starting instructions, marked as untrusted data and kept on the session row so a
  resume rebuilds the same prompt — and wait for the operator's first message rather than
  receive it as a first user message. With no issue the prompt carries only the caller's
  instructions, marked the same way, in place of the issue's text;
- take its repos, agent and model from the call, each falling back to what the New session form
  would pre-select: the issue's repos (primary first; none gives a home-directory session, as does
  an issue-less start with no repos), the
  form's pre-selected (remembered) agent for one repo or several, and that agent's remembered model. A provider or
  model the form does not offer is rejected with the allowed list, never substituted. There is
  no backend choice: every session runs as a pod;
- hold only the baseline grant — the implicit capabilities and the agent's own login. Every
  other capability the call names becomes a pending request on the new session that the
  operator approves or denies on its page, and one that cannot be granted to a running session
  rejects the whole call before anything is created;
- be fully independent once created: its own checkout, terminal page, history and usage row,
  with no live link to its creator, so ending, reviving, deleting or crashing either leaves the
  other alone, and no channel between them afterwards;
- record who started it: the row names the starting session and the issue, the session page
  shows "Started by session …", and an issue, when one is named, gets a Claws-marked audit
  comment. An issue-less start creates no issue and posts no comment.

One session may have at most five live sessions it started at once, issue-bound and issue-less
counted together. The caller gets the new
session's id and dashboard URL.
**Why:** handing a separate issue to a dedicated session meant leaving the session, opening the
dashboard and re-entering the context by hand (#clw_01M4BD4HVYGHT1AF1Z5XNQ6BGE). Letting the
request grant capabilities would hand an agent the approval only the operator may give, so it
goes through the same live-grant path as `claws_request_capability`. An operator asked a session
to start a separate session for work with no issue yet (2026-10-09); it had to file a
placeholder issue with a vague scope, which then sat in Drafting for the requirements writer
(#clw_01M4G6RMF5EF0AF0VZPTAYNDRJ), so starting a session must not require an issue.

### Let the operator give an agent session its first message when starting it

Both New Session forms on the Sessions page (single-repo and multi-repo) offer an optional,
multi-line Initial prompt. It is the operator's own first message, not untrusted data: the agent
receives the exact text (trimmed, at most 16,000 characters) as its first user message as soon as
its CLI starts, and begins working on it without further input, for every agent provider the form
offers. It is handed to the agent CLI's own initial-prompt argument at launch, never typed into
the terminal, so reloading the page or reconnecting the terminal during start-up cannot drop or
repeat it. It is kept on the session row until the session first reports ready, and a relaunch
before then (a resume after a failed start) carries it again; after that, no relaunch does. The
field is disabled for "zsh in repo", which starts no agent, and leaving it empty starts the
session exactly as before. `claws_start_session`'s starting instructions are unchanged. The
board's Start session button uses the same delivery for its issue-id opening message (see
[Start a session from a board card](dashboard-and-integrations.md#start-a-session-from-a-board-card)).
**Why:** the operator had to wait for the pod and agent to spin up before typing their first
question, and typing during start-up would race the agent becoming ready
(#clw_01M4ZBH4EE9PMG9MXP3KY904SP).

### Keep terminal controls usable on touch devices

The terminal must remain the primary workspace on phone and tablet viewports, with a
horizontally scrollable keybar whose controls fire on release and include utility keys. A
voice note must not re-prompt for microphone permission on every recording on a tablet,
releasing the microphone only when the page is hidden, the session ends, or the control
sits idle.
**Why:** touch users need both room for the terminal and reliable terminal input.

### Keep a session page's header and controls compact

The session page spends as little vertical space as it can on its header, status and controls, collapsed sections (such as Files) included, on a phone above all, so the terminal stays the primary workspace.
**Why:** the operator reported the header and a collapsed Files section taking too much of a phone screen (#clw_01M4ZHNH4BJZMHM637Z94MPM8C, #clw_01M4XZ8ED7WV8XCZZ8QAQJ76ED).

### Keep the session bar's actions on screen on a phone

On a phone the session page's action row — paste, copy, attach, record, capability select, Grant and Revoke — must fit the
visible width without sideways swiping. On a phone Paste, Copy and Attach are symbols with
accessible names, and the row has no Back control. The capability select never sizes to its longest
option's explanation, and there is no separate Set Title control: a title is set
automatically or with the title command.
**Why:** a select as wide as the screen pushed Grant and Revoke out of reach on a phone, and the
row later grew past the screen again (#clw_01M5361DC0FEV6QD3CB97GBZDN).

### Let agents and sessions read the attachments of the issue they work on

An agent or session working a native issue can list and read that issue's stored attachments
(images included) through Claws tools, not only see them in the dashboard. This covers headless agents too, as
the on-demand tools; see "Agents read only files held in Claws' own issue tracker" in
[operations-and-safety.md](operations-and-safety.md) for the rule on what they may read.
**Why:** the owner pasted a screenshot to describe a bug and the agent working it could not see it.

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

### Print to the LAN printers only through an explicit print grant

A session granted the `print` capability must be able to send a PDF, plain text or image
to the HP LaserJet 4050 or the HP Envy 6100e through the fleet CUPS service, with ryzen
powered off, and learn whether CUPS completed the job. Prints are A4 at 1:1 scale by
default, with scaling to fit one documented option away. The capability's usage text names
both printers and how to pick one, and says a 4050 paper mismatch shows only on the
printer's panel. `print` follows the same default-deny, explicit-grant and live-grant rules
as every other capability, is unavailable when `CLAWS_PRINT_SERVER` is unset, is never
granted automatically, and a session without the grant has neither the CUPS server pointer
nor the print wrapper (#clw_01M498X85G9KCWHAX28RHG0F7Y, 2026-10-06).
**Why:** printing is physical and non-reversible, so it needs the operator's explicit
approval; the previous path needed ryzen powered on and a live `ssh:ryzen` grant.

### Pre-select the operator's last-chosen agent and model

The New session forms (single-repo and multi-repo) must pre-select the agent of the operator's
most recent dashboard-created session and, per agent, the model last used with it, and
`claws_start_session` must use the same defaults when agent or model is omitted. The choice is
held by the server (per instance), so it applies across browsers, devices and the tool. A
remembered model that is no longer offered, a rate-limited remembered agent, a remembered agent
the multi-repo form does not offer, or nothing remembered falls back to the fixed defaults. A
custom model id is not remembered (the agent still is), and a repo-zsh session or an agent-started
session records nothing (#clw_01M4TJJH1RK76ZHS0JB64KTQJ8, 2026-10-13). The board's Start session
button uses the same defaults, and the capabilities the form would pre-tick, without recording
anything (#clw_01M52AKRRVN170EE506CRZD9VM).
**Why:** operators who usually use another agent or model had to re-pick them on every new session.

### Name the session page's browser tab after the session

The browser tab title of an interactive session page must be the session's title followed by
its selected repos (`Fix login — claws, other`), with no separator when it has no repos and
`Session <id8>` standing in for a missing title, and it must follow retitles without a reload
(#clw_01M4DPDA35PN061BVHDH4NGXP5, 2026-10-08).
**Why:** operators keep several session pages open and identical tab titles made them
indistinguishable.

### Keep upload and voice-note notices off the terminal

Routine upload and voice-note progress (uploading, transcribing, processing, attached, sent)
is never shown over the terminal. Failures and warnings (upload failed, microphone denied,
recording unsupported, empty recording) appear in an in-flow row of the session bar until
the operator dismisses them.
**Why:** operators reported the floating toasts were in the way of the terminal
(#clw_01M4X5GHGKA19HP3VDH790TEMP).

### Give agents read-only access to cluster metrics, logs and alerts

A session may be granted `prod-observability` and/or `fleet-observability` to query that
cluster's Grafana (Prometheus and Loki datasources, firing alerts, dashboards) with a
Viewer service-account token. Each is opt-in, pre-ticked for the repos that already default to
that cluster's infra capability, hidden when its token is unset, live-grantable, and offered to
headless planners for read-only diagnosis; the token never appears on argv, in logs or in the prompt.
**Why:** #3250 removed Claws' own cluster monitoring and left agents no way to inspect metrics or
logs while investigating an issue; this serves "give interactive agents the context and least
privilege needed to make evidence-based progress" in `docs/PRODUCT.md#goals`.

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
