---
name: ship
description: Drive a feature end-to-end through the Claws pipeline — check the plan on each issue, apply Refined, watch for the PR, merge when it qualifies, verify the deployment, then loop onto the next issue or follow-up. Use when asked to ship, land, drive, or babysit a feature, issue, or set of issues through to production.
---

You are steering the Claws pipeline, not doing the work yourself. Default to
letting Claws plan, implement, review and merge; your job is the gates
between those steps. Never invoke `.agents/issue-refiner`,
`.agents/issue-implementer`, or `.agents/pr-reviewer` as subagents. Never
post a comment carrying the "Automated by Claws" footer — that marker is how
Claws recognises its own comments, and one on a human comment makes it
invisible to the pipeline. All changes land via PR; never push to the
default branch.

## Phase 0 — Scope

Resolve the argument. An explicit argument always wins over anything
inferred from the session.

- `/ship #123` or `/ship owner/repo#123` — that specific issue.
- A free-text feature description — find the matching issues, or file them
  if none exist.
- `/ship --all` (also `/ship all`) — repo-wide resume: list open `claws/`
  PRs and issues labelled `Refined`.
- Bare `/ship` — inherit the session's subject if it has one; only fall
  back to the repo-wide resume when it does not, and confirm before acting.

### Bare `/ship` inherits the session's subject

The session's subject is the PR or issue this conversation has already
worked on — opened for, commented on, merged, or performed a manual action
on. When there is exactly one, bare `/ship` is scoped to that item and
nothing else. Do not list unrelated items: a row in the work-list table
reads as "in scope" no matter how it is captioned.

Enter the phases at whatever stage the subject is already at — a merged PR
starts at Phase 5 (deploy verification), not Phase 1.

If the session has touched more than one item, list only those and ask
which one to drive.

If the session has no subject — bare `/ship` is the first instruction —
print the repo-wide list as a *proposal* and get a yes before applying any
label or starting any item. Read-only checks (`gh issue view`,
`gh pr checks`, `claws_open_prs`) need no confirmation; anything that
mutates GitHub state does.

Never apply **Refined** to an item outside the scope resolved here.

### **Ready** issues are not work

**Ready** means Claws has stopped and is waiting on a human (Phase 2), and
an issue can sit **Ready** indefinitely. Omit **Ready** issues from the
work list unless the operator asked for a backlog review or named one
explicitly. If they are worth mentioning at all, mention them as a
one-line count outside the table.

Build an explicit work list as a markdown table with columns issue, current
stage, next gate, blocker, and **verified by** — the concrete artefact that
will prove the item shipped (a release tag, a Flux reconcile at a commit
reported by the repo's CI, a `/health` version, a Grafana panel). Fill `verified by` in as
soon as Phase 5 establishes it; that column is what the final report in
Phase 7 is built from. Re-print this table at the end of every loop pass
(Phase 6) so the operator can see progress at a glance. If the scope needs
work that has no issue yet, file the issue and stop there for that item —
do not write the plan yourself.

## Phase 0.5 — Requirements gate

A native `clw_…` issue in **Drafting** or **Requirements review** has not
been approved yet: the requirements writer drafts a requirements record, and
nothing plans the issue until it is promoted. Read it with
`claws_get_issue` (`issue_id`), which returns the issue's `stage` and its
`requirements` record — the latest version's fields and rendered `body`,
whether it is `approved` and by whom, and `previous_requirements`.

- `stage: "drafting"` — the writer has not stored a record yet, or is
  revising it after feedback. Wait for the next version with
  `claws_wait_for_change` (`items: ["<clw_id>"]`,
  `kinds: ["requirements-stored"]`) rather than polling.
- `stage: "requirements-review"` — a record is waiting on a human. Check it
  against the issue body and every later comment: a requirement the body
  or a comment states that no acceptance criterion covers, a criterion that
  asks for something nobody asked for, or out-of-scope items that contradict
  the issue. Show the operator the record and any gaps you found.
- Any later stage — the issue was already promoted; go on to Phase 1.

If the record needs a correction, post it as a plain comment with
`claws_comment_on_issue` (no Claws footer) — the writer revises the record
from that feedback, and the issue returns to Drafting until it stores the
next version. Then wait for the next `requirements-stored` and check the new
version the same way. Never edit the requirements record or the issue body
to fix it.

Promote with `claws_promote_issue` (`issue_id`) — the dashboard Promote
button's write — only once the operator has approved the record, or
unattended when they said to proceed without review. Only for items inside
the Phase 0 scope. A `stage-changed` event (detail `ideas->planning`) from
`claws_wait_for_change` confirms the promotion; the planner then runs as in
Phase 1. Forge issues have no session-readable record; skip this phase for
them.

## Phase 1 — Plan gate

For each issue, read `gh issue view <n> --repo <owner>/<repo> --comments`
(for a native `clw_…` issue, `claws_get_issue` returns its current plan and
comments instead). A Claws plan is a comment containing the header `## Implementation Plan`
*and* the "Automated by Claws" footer. If none exists, the planner has not
run yet — dispatchers tick every 5 minutes, so wait and re-check rather than
concluding anything is wrong.

When a plan exists, judge it against the issue: does it name concrete
files, does it match the current code, does it miss a requirement stated in
a later comment. If it is wrong or thin, post a normal comment with the
specific correction (no Claws footer) — Claws treats comments as feedback
and refines the plan in place — then re-check on the next pass.

Never edit the issue body once a plan comment exists: Claws hashes the body
it planned against and a body edit forces a full re-plan and blocks
implementation until it finishes.

If the operator has asked for a plan review, present the plan's weak points
and get approval before Phase 2 unless they said to proceed unattended.

## Phase 2 — Refined

**Refined** is the *only* label that makes Claws implement an issue and open
a PR. **Ready** is the opposite: it means Claws has stopped and is waiting
on a human, and an issue can sit **Ready** forever. Never report that a PR
is coming because an issue is **Ready**.

For a native `clw_…` issue, apply it with the `claws_set_issue_label` MCP tool
(`issue_id`, `label: "Refined"`, `present: true`); pass `present: false` to
undo a premature apply. For a forge issue, use `gh issue edit <n> --repo <r>
--add-label Refined`. A native issue has no forge copy, so `gh issue edit`
cannot reach it — do not ask the operator to click Refine on the issue page
instead.

A native issue still in **Drafting** or **Requirements review** must be
promoted before it is planned — see Phase 0.5. If bare `/ship` inherited a single
subject, that is the only issue this label may be applied to without asking.

Other labels worth knowing: **Priority** (front of every queue), **Blocked**
(Claws skips entirely — resolve the external precondition or drop the
label), **Claws Ignore**, **Claws Problematic** (PR blew the CI-fix
budget), **Plan: Deep**, **Use Codex** / **Use Claude**, **Automerge**. On a
native issue, every one of these the issue page's Labels form offers goes
through `claws_set_issue_label`, and `claws_set_issue_model_plan` sets a phase's
provider/tier (read the current plan with `claws_get_issue_model_plan` first).
The rest of the issue page has session tools too: `claws_set_issue_state`
closes a native issue as `completed` or `not_planned`, or reopens it;
`claws_edit_issue` edits its title or body (prefer a comment to a body rewrite
— a body edit on a planned issue forces a re-plan); `claws_set_issue_repos`
sets its repos; `claws_set_issue_column` moves it to a board column such as
Backlog. Do not ask the operator to do any of these on the dashboard.

## Phase 3 — Multi-PR plans

A plan split by `### PR 1:` / `### PR 2:` headers ships one step per
dispatcher cycle, with **Refined** re-applied after each merge. Before
assuming a step is stuck, call the `claws_issue_phases` MCP tool (`repo`,
`issue`) to see which steps Claws believes are covered and by which PR.
Claws will not start step N+1 while step N's PR is still open — that is
correct behaviour, not a stall.

When the scope came from the session's subject rather than an explicit
argument (see Phase 0), do not advance a multi-PR plan to its next step on
your own. After step N merges, say which step is next and what it will do,
then ask the operator before re-applying **Refined**. **Refined** starts an
implementer and opens a PR — advancing a plan the operator did not ask
about is exactly the widening bare `/ship` must avoid.

If you take a step by hand, title the PR `fix: <step title>
(N/M)` and open the body with `## PR N of M: <step title>` then `Part of
#<issue>` (`Closes #<issue>` only on the final step) — the issue ref goes in
the body, not the title. For a step producing
no PR, comment `claws-phase-done: <numbers>` (comma list or hyphen range) as
the first text on its own line — not inside a code fence or a blockquote, and
never in a comment carrying the Claws footer, or it is ignored.

## Phase 4 — PR gate

Find the PR with the `claws_open_prs` MCP tool or `gh pr list --repo <r>
--search "<issue-number>"`. Check `gh pr checks` and `gh pr view
--comments`.

Before you change GitHub state — applying **Refined**, applying
**Automerge** — call `claws_wait_for_change` with
`timeout_seconds: 0` to capture the current `lastId`, and pass that as
`after` on the wait that follows. Otherwise a transition that lands between
the mutation and the wait is missed and you sit out the full timeout.

Do not merge, and do not ask Claws to merge, while CI is red — the ci-fixer
gets its own attempts first.

When a PR's only red check is an infra or transient failure — runner lost,
network, registry or S3 timeout, not the change itself — re-run it with the
`claws_rerun_failed_ci` MCP tool (`repo`, `pr_number`, optional `run`).
It re-runs only the failed jobs of the newest failed run on the head commit,
with no commit pushed. Never push an empty commit to re-trigger CI: that
re-runs every workflow, passed jobs included. On a Forgejo repo the tool
answers "endpoint unavailable" until our Forgejo image carries the re-run
patch; report that and stop on the PR rather than pushing.

Auto-merger requires: green checks, no `Claws Ignore` / `Blocked` / `Manual
Action` label, not a fork, not conflicting, and *either* the **Automerge**
label with a clean Claws review of the current head commit, *or* an exempt
category (dependabot, `claws/docs-*`, `claws/ideas-collect-*`, auto-bump).
A bare `LGTM` comment approves nothing — that mechanism was removed in #3135
because anything holding Claws' installation token could post one.

**Manual Action** mirrors a manual-action record in Claws' own store, and the
auto-merger blocks on the record, not the label. When the step the PR's
Manual Action note names is verifiably done, clear the record with the
`claws_clear_pr_manual_action` MCP tool (`repo`, `pr_number`).
`gh pr edit --remove-label "Manual Action"` does not clear it — Claws puts
the label back — and without the tool, ask the operator to use the
dashboard's **Clear manual action** button.

Prefer approving through the pipeline (apply **Automerge**) over
`gh pr merge`, so Claws' own accounting and post-merge steps run. For a PR
of a native `clw_…` issue, apply it with `claws_set_issue_label`
(`label: "Automerge"`, `present: true`) on the issue rather than
`gh pr edit --add-label`: it approves the merge of every open PR for the
issue, recorded as this session's approval, and of the next PR if none is
open yet. `present: false` withdraws it. For a forge issue's PR,
`gh pr edit <n> --repo <r> --add-label Automerge`.

### Verify encrypted secret material before approving

If the diff touches a SOPS file (`*.enc.yaml`), do not take the PR
description's word for what is inside it. Decrypt locally and compare a
digest against the source of truth — never print plaintext into the
transcript, a comment, or a PR body.

Point SOPS at the repo's own age key, e.g. for `fleet-infra`:

```bash
export SOPS_AGE_KEY_FILE=~/.config/sops/age/fleet-infra.agekey
sops -d path/to/thing.enc.yaml | yq -r '.data["key.pem"]' \
  | base64 -d | openssl rsa -pubout 2>/dev/null | sha256sum
```

Compare that fingerprint (or a plain `sha256sum` of the decrypted value)
against the same computation over the real source material — the PEM on
disk, the value in the live cluster Secret, or the credential from the
provider. Equal digests prove the committed ciphertext carries the real
key. A mismatch, or a value that decrypts to an empty/placeholder string
when the description implies otherwise, is **blocking**: say so and do not
approve the merge.

### Check the post-merge manual-action section against live state

If the PR body has a `## 📋 Manual action required after merge` section,
verify every factual claim in it before approving. The auto-merger copies that
section verbatim into a post-merge PR comment and a Slack ping, so a wrong
description becomes a wrong operator instruction that outlives the PR.

The two failures seen in practice, both from Claws-authored descriptions:

- "populate the Secret's key material, it's committed empty" — the SOPS
  file already carried the real key (see the gate above).
- "the old PVC was already deleted from the cluster by hand" — it was
  still `Bound`.

Check each claim against what you can read: the repo's CI and Flux reconcile
status, `/health`, Grafana, the decrypted SOPS value, the actual file. A
claim about live cluster objects you cannot corroborate that way (a PVC's
phase, a Secret's keys) is for the operator: say so in the section rather
than asserting it. Rewrite the section with
`gh pr edit <n> --repo <r> --body-file -` when it is wrong. Delete the
section entirely if no manual action is in fact required.

Editing a **PR** body is safe and expected here. The Phase 1 warning about
never editing a body applies to **issue** bodies only, where a change
re-hashes the planned-against body and forces a full re-plan.

### A stale "request changes" is not a blocker

The reviewer can race a PR-body edit: correct the description, and the
Claws Reviewer may still post "request changes" against the wording it
read before your edit. The Review Addresser then runs, finds nothing to
change, and comments to that effect.

That combination — a "request changes" whose only blocking item is text
you have already fixed, followed by a clean Review Addresser comment — is
not a blocker. Applying **Automerge** once the Claws review of the
current head is clean overrides it and is the intended path out.
Confirm the addresser comment is genuinely a no-change confirmation
and not a deferred fix before treating it that way.

PRs touching OpenTofu/Terraform infrastructure are never auto-merged by
design: a human must merge them, so say so rather than merging.

When the operator rules on an escalated review or a reviewer finding —
accept it, overrule it, settle a choice — post the ruling with the
`claws_comment_on_pr` MCP tool (`repo`, `pr_number`, `body`), in the
operator's words. Claws' reviewer and review addresser read it as human
input. Never post a ruling with `gh pr comment` or a curl to the forge: the
session's token is Claws' own bot account, so Claws ignores that comment or
reads it as its own output.

A **Claws Problematic** PR needs its diagnosis report read first. Once the
operator has settled the escalation or the cause the report names, call
`claws_unmark_problematic` (`repo`, `pr_number`): it returns the PR to
the normal CI-fix and review flow with a fresh fix budget. When the report
says the diagnoser could not read the job logs, or a fix has since changed
the picture, call `claws_retry_problematic_diagnosis` so it diagnoses
again on its next pass.

## Phase 5 — Deploy verification

After merge, confirm the change actually reached production for *this*
repo — discover how from the repo itself, do not assume. Check in order:

1. `gh run list --repo <r> --branch <default-branch> --limit 5` for the
   release/deploy workflow, and `gh run view <id> --log-failed` on a
   failure. That is for GitHub repos only. For a Forgejo repo, list runs
   in the forge UI (`/actions`) or the Forgejo API
   (`/api/v1/repos/<r>/actions/runs`), and read a failure with
   `claws_forgejo_job_logs(repo, run)`. `run` is the number in
   `/actions/runs/<n>`.
2. The repo's own `docs/` for a deployment section.
3. For GitOps repos, the reconcile status.

**Do the named post-merge action, or report it?** Sessions hold no Kubernetes credentials, so a cluster action named in the merged PR's post-merge section — running a one-off Job, deleting a PVC or a Secret, patching or restarting a workload — is always **reported back to the operator**, never run. Only a forge-side action (a label, a release, an issue or PR edit) may be done as part of shipping, and only when its precondition is verifiable from what you can read (the repo's CI, Flux reconcile status, `/health`, Grafana) and the issue or PR text names the exact command. Anything whose precondition you cannot check without guessing is reported too. State in the Phase 7 report which category each action fell into and, for the ones you ran, the command and its result.

For the `claws` repo itself, Claws runs as the StatefulSet pod
`claws-0` in namespace `default`. There is no systemd timer, and
the old `.current-version` / `.skipped-versions` files that used to live
under `/opt/claws` are gone too — those were the pre-Kubernetes deploy
path, and reading them in a container returns "No such file or directory".

The check is the service's own public health route, which reports the
running release tag:

```bash
gh release list -R St-John-Software/claws --limit 3
curl -s http://localhost:3000/health
```

It returns `{"status":"ok","version":"vYYYYMMDD.N",...}`. If `localhost` is
not the Claws pod (an interactive session runs in its own pod), use the
service address the session's `claws-state` MCP endpoint points at:
`http://claws.default.svc.cluster.local:3000/health`. The deploy
landed when `version` equals the release tag cut from your merge commit.
`/health` needs no auth; every *other* route answers 401, so probing those
proves nothing about the version.

Budget ~20–25 minutes, not "a couple of minutes" — the change goes through
an image build and a second repository's PR (observed 2026-09-16: merge
17:54Z → pod ready 18:17Z). A `version` still showing the previous tag five
minutes after merge is normal, not a failure.

While waiting, locate the rollout rather than re-curling: `release.yml` cuts
the tag, builds `ghcr.io/st-john-software/claws:<tag>` and dispatches
fleet-infra's `update-claws.yml`, which opens a PR on branch
`automation/bump-claws` titled `chore(claws): update image to <tag>`; Claws auto-merges it on green CI and Flux then rolls the pod.
Check it with:

```bash
gh pr list --repo St-John-Software/fleet-infra --state all \
  --head automation/bump-claws --limit 3 \
  --json number,title,state,mergedAt
```

A merged bump PR carrying your tag means the rollout is in Flux's hands. Do
not open or merge that PR by hand — verification only.

If no bump PR appears after ~10 minutes, read the release run instead of
waiting: `gh run list -R St-John-Software/claws --workflow release.yml
--limit 3`, then `gh run view <id> --log-failed`. The dispatch step is
skipped when the image build fails.

If neither health address is reachable, the merged bump PR alone is
sufficient evidence.

Secondary corroboration: `claws_wait_for_change` returning `restarted: true`
after the bump PR merged means the service restarted, consistent with the
pod rolling, though it does not identify the version.

Never start a long-running process or a dev server to check a deploy.

## Phase 6 — Loop

Re-print the work-list table from Phase 0, then either continue to the next
item or wait for the next transition with the `claws_wait_for_change` MCP
tool rather than sleeping:

```
claws_wait_for_change({ repo: "<owner>/<repo>", items: [<issue>, <pr>], after: <lastId>, timeout_seconds: 240 })
```

It returns the instant Claws posts a plan, applies a label, opens or merges
a PR, or an agent task fails — usually far sooner than a fixed sleep — and
returns an empty `events` list after 240 s if nothing happened. Feed
`lastId` back as `after` on the next call. Only Claws' own actions are
reported, so still confirm with `gh` before acting, and re-check state with
`gh` whenever `restarted` is true (the service restarted and your cursor is
void).

When the tool is unavailable (Codex sessions, browser-capability sessions),
fall back to a backgrounded wait — a bare foreground `sleep` is blocked by
the Claude Code harness, so put the wait **and** the recheck in one
backgrounded command that writes to a file, and read the file when the
completion notification arrives:

```bash
# Bash tool, run_in_background: true
sleep 240; gh pr list --repo <r> --search "<issue>" --state all \
  --json number,title,state,labels > /tmp/ship-poll.txt 2>&1
```

Dispatchers tick every 5 minutes, so anything under ~120 seconds learns
nothing; 240-300 seconds per fallback pass is the right cadence.

Bound the wait by elapsed time, not by pass count: **stop and report after
roughly 45 minutes with no observable state change** (no new comment, label,
commit, PR or check transition). A full plan → implement → review → merge
cycle is longer than a few passes, so a pass-count bound reports "stuck" on
a pipeline that is moving normally.

For genuinely hands-off monitoring, tell the operator they can run `/loop
10m /ship` instead of leaving this session spinning. Do not start
background daemons, watchers or tunnels.

## Phase 7 — Stop and report

Stop and hand back when: every item is merged and deployed; an item is
**Blocked** or needs a human decision; CI fails for a reason outside the
change that `claws_rerun_failed_ci` cannot clear; or a plan needs approval
the operator has not given.

A **Claws Problematic** PR is not an automatic stop. Unmark it with
`claws_unmark_problematic` when the operator has settled its cause, or
retry diagnosis with `claws_retry_problematic_diagnosis` when the report
says the logs were unreadable. Stop on it only when neither applies.

Report as a table plus one line per item on what is needed from the human.
If shipping surfaced follow-up work, file it as a new issue and add it to
the work list — do not implement it here.

## Fallbacks

The `claws_*` MCP tools (`claws_status`, `claws_open_prs`,
`claws_task_history`, `claws_issue_phases`, `claws_wait_for_change`,
`claws_config`, `claws_set_issue_label`, `claws_promote_issue`,
`claws_get_issue_model_plan`, `claws_set_issue_model_plan`,
`claws_clear_pr_manual_action`, `claws_rerun_failed_ci`,
`claws_unmark_problematic`, `claws_retry_problematic_diagnosis`,
`claws_set_issue_state`, `claws_edit_issue`,
`claws_set_issue_repos`, `claws_set_issue_column`) exist only in Claude
sessions, not in Codex sessions or browser-capability sessions. The
native-issue write tools — `claws_set_issue_label`, `claws_promote_issue`,
`claws_set_issue_model_plan`, `claws_clear_pr_manual_action`,
the PR recovery tools `claws_rerun_failed_ci`, `claws_unmark_problematic`
and `claws_retry_problematic_diagnosis`,
`claws_set_issue_state` (close as completed or not planned, reopen),
`claws_edit_issue` (title and body), `claws_set_issue_repos` and
`claws_set_issue_column` — exist only in an interactive session with the
`claws-state` server, regardless of provider; where they exist, use them rather
than sending the operator to the dashboard.
Every step above has a plain `gh` equivalent for a forge issue — use it when a tool is
unavailable rather than aborting. A native issue's writes have no `gh`
equivalent: only a session without these tools (a `browser` session, or any session when
`CLAWS_SESSION_MCP_URL` is unset) asks the
operator to do them on the dashboard.
