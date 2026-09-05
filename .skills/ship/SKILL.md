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
  PRs and issues labelled `Refined` or `In Review`.
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
will prove the item shipped (a release tag, a Flux reconcile at a commit, a
`kubectl get` on the object the change creates). Fill `verified by` in as
soon as Phase 5 establishes it; that column is what the final report in
Phase 7 is built from. Re-print this table at the end of every loop pass
(Phase 6) so the operator can see progress at a glance. If the scope needs
work that has no issue yet, file the issue and stop there for that item —
do not write the plan yourself.

## Phase 1 — Plan gate

For each issue, read `gh issue view <n> --repo <owner>/<repo> --comments`. A
Claws plan is a comment containing the header `## Implementation Plan`
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

Apply with `gh issue edit <n> --repo <r> --add-label Refined`.
Only for items inside the Phase 0 scope. If bare `/ship` inherited a single
subject, that is the only issue this label may be applied to without asking.

Other labels worth knowing: **Priority** (front of every queue), **Blocked**
(Claws skips entirely — resolve the external precondition or drop the
label), **Claws Ignore**, **Claws Problematic** (PR blew the CI-fix
budget), **Plan: Deep**, **Use Codex** / **Use Claude**, **Automerge**.

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

If you take a step by hand, title the PR `fix(#<issue>): <step title>
(N/M)` and open the body with `## PR N of M: <step title>` then `Part of
#<issue>` (`Closes #<issue>` only on the final step). For a step producing
no PR, comment `claws-phase-done: <numbers>` (comma list or hyphen range,
no Claws footer).

## Phase 4 — PR gate

Find the PR with the `claws_open_prs` MCP tool or `gh pr list --repo <r>
--search "<issue-number>"`. Check `gh pr checks` and `gh pr view
--comments`.

Before you change GitHub state — applying **Refined**, applying
**Automerge**, posting `LGTM` — call `claws_wait_for_change` with
`timeout_seconds: 0` to capture the current `lastId`, and pass that as
`after` on the wait that follows. Otherwise a transition that lands between
the mutation and the wait is missed and you sit out the full timeout.

Do not merge, and do not ask Claws to merge, while CI is red — the ci-fixer
gets its own attempts first.

Auto-merger requires: green checks, no `Claws Ignore` / `Blocked` / `Manual
Action` label, not a fork, not conflicting, and *either* the **Automerge**
label with a clean Claws review of the current head commit, *or* a valid
human LGTM. A valid LGTM is a comment whose entire trimmed body is exactly
`LGTM` (case-insensitive), without the Claws footer, posted **after** the
latest non-merge commit — a new push invalidates the previous one.

Prefer approving through the pipeline (post `LGTM`, or apply **Automerge**)
over `gh pr merge`, so Claws' own accounting and post-merge steps run.

### Verify encrypted secret material before LGTM

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
LGTM.

### Check the post-merge manual-action section against live state

If the PR body has a `## 📋 Manual action required after merge` section,
verify every factual claim in it before LGTM. The auto-merger copies that
section verbatim into a post-merge PR comment and a Slack ping, so a wrong
description becomes a wrong operator instruction that outlives the PR.

The two failures seen in practice, both from Claws-authored descriptions:

- "populate the Secret's key material, it's committed empty" — the SOPS
  file already carried the real key (see the gate above).
- "the old PVC was already deleted from the cluster by hand" — it was
  still `Bound`.

Check each claim against live state (`kubectl get` on the named object,
the decrypted SOPS value, the actual file) and rewrite the section with
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
not a blocker. A human `LGTM` posted after the latest non-merge commit
overrides it and is the intended path out. Confirm the addresser comment
is genuinely a no-change confirmation and not a deferred fix before
treating it that way.

Two exceptions where a human must merge and you should say so rather than
merging: PRs touching OpenTofu/Terraform infrastructure are never
auto-merged by design, and **Claws Problematic** PRs need the diagnosis
read first.

## Phase 5 — Deploy verification

After merge, confirm the change actually reached production for *this*
repo — discover how from the repo itself, do not assume. Check in order:

1. `gh run list --repo <r> --branch <default-branch> --limit 5` for the
   release/deploy workflow, and `gh run view <id> --log-failed` on a
   failure.
2. The repo's own `docs/` for a deployment section.
3. For GitOps repos, the reconcile status.

**Do the named post-merge action, or report it?** A manual action named in the merged PR's post-merge section is part of shipping when *all three* hold: its precondition is verifiable from live state (the GitOps controller has reconciled the merge commit, nothing still references the object, the repo's own verification reports OK); the action is reversible or trivially re-seedable; and the issue or PR text names the exact command. A `kubectl delete` of a superseded PVC or a retired hand-seeded Secret qualifies once nothing references it. Anything else — irreversible deletions, actions on systems outside the cluster, anything whose precondition you cannot check without guessing — is **reported back to the operator**, not executed. State in the Phase 7 report which category each action fell into and, for the ones you ran, the command and its result.

For the `claws` repo itself, `deploy/deploy.sh` runs on a 60-second systemd
timer, so a merged change is live within a couple of minutes and a
successful deploy is deliberately silent. Do not try to probe dashboard routes
— every route including `/health`'s siblings answers 401, so a response proves
nothing about the version. Verify by comparing the installed version against
the release tag cut from the merge commit:

```bash
gh release list -R St-John-Software/claws --limit 3
cat /opt/claws/.current-version
```

Release tags are `vYYYYMMDD.N` (`release.yml` computes them). `.current-version`
matching the tag whose release was created by your merge means the deploy
landed; a stale value after a few minutes means it did not, and
`/opt/claws/.skipped-versions` is worth reading.

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
**Blocked** or needs a human decision; a PR is **Claws Problematic**; CI
fails for a reason outside the change; or a plan needs approval the
operator has not given.

Report as a table plus one line per item on what is needed from the human.
If shipping surfaced follow-up work, file it as a new issue and add it to
the work list — do not implement it here.

## Fallbacks

The `claws_*` MCP tools (`claws_status`, `claws_open_prs`,
`claws_task_history`, `claws_issue_phases`, `claws_wait_for_change`,
`claws_config`) exist only in
Claude sessions, not in Codex sessions or browser-capability sessions.
Every step above has a plain `gh` equivalent — use it when a tool is
unavailable rather than aborting.
