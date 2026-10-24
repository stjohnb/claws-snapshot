---
name: status
description: Report the current live state of every issue, PR, CI run and deployment this session is responsible for, and what is blocked or waiting on the operator. Use when the user types /status, or asks "where are we", "what's the status", "what's outstanding".
---

Answer one question the same way every time: **where does every piece of work
this session is responsible for stand right now?** The report is read-only and
built from lookups made during this invocation. Session memory may say what to
look up, never what state it is in.

The argument, if any, narrows the report to one issue, PR or repo. `/status`
with no argument covers the whole session.

This skill runs in a worktree of whatever repo the session is working on —
never assume a `claws`-repo-relative path exists.

## Read-only

Never call `claws_set_issue_label`, `claws_merge_pr`, `claws_approve_pr_merge`,
`claws_rerun_failed_ci`, `claws_comment_on_pr`, `claws_comment_on_issue` or
`claws_create_issue`, and never run `gh pr merge` or `git push`. Do not propose
filing issues or fixing findings; only report them. Never start a server or
poll in a loop.

## Phase 1 — Scope

Inventory the conversation: the issues worked on, PRs opened, commented on or
merged, branches, every repo or worktree changed, and manual actions promised
to the operator. The session's own native issue is always in scope.

Recover what compaction dropped: `gh search issues --author @me --updated ">=<date>"`
and `gh search prs --author @me --updated ">=<date>"` for GitHub repos, and
`claws_list_issues` (filtered to the session's repos) for native issues. Do not
report work belonging to other sessions or unrelated repos.

If the scope is empty, print exactly
`Nothing in progress — this session has raised no issues, PRs or changes.`
and stop.

## Phase 2 — Issue state (live)

- Native issues: `claws_get_issue` for `stage`, `stage_title`, labels,
  `blocked_reason`, `backlog_until` and whether the plan is approved. For
  multi-PR plans call `claws_issue_phases` and list each step's status (done,
  pending, ready, blocked, manual, `awaitingOperator`). Call `claws_task_history`
  per repo and issue so a failed Claws job (planner, implementer, ci-fixer)
  shows as a blocker.
- GitHub forge issues: `gh issue view <n> --repo <o>/<r> --json state,labels,updatedAt`.
- Forgejo forge issues: `curl -sH "Authorization: token $CLAWS_FORGEJO_TOKEN" "$CLAWS_FORGEJO_BASE_URL/api/v1/repos/<owner>/<repo>/issues/<n>"`.

## Phase 3 — PRs (live)

`claws_open_prs` per repo lists open PRs only (number, title, branch, labels,
draft). Merged PRs come from the conversation inventory or the author searches;
they are still rows, so the operator sees they landed while idle. Carry the
merge or failure time on those rows.

- GitHub: `gh pr view <n> --json state,isDraft,reviewDecision,mergedAt,statusCheckRollup,labels` and `gh pr checks <n>`.
- Forgejo: `GET /repos/<o>/<r>/pulls/<n>` (state, merged, mergeable, head sha),
  `GET /repos/<o>/<r>/pulls/<n>/reviews`, and
  `GET /repos/<o>/<r>/commits/<sha>/status` for the combined CI state. When that
  is empty, use `GET /repos/<o>/<r>/actions/runs` filtered client-side on
  `.commit_sha`. Summarise a failed run in one line with
  `claws_forgejo_job_logs(repo, run)`; do not diagnose.

All Forgejo calls use `curl -sH "Authorization: token $CLAWS_FORGEJO_TOKEN" "$CLAWS_FORGEJO_BASE_URL/api/v1/..."`.

## Phase 4 — Deployment (merged PRs only)

Decide relevance per merged PR:

- `claws` repo: `curl -s http://localhost:3000/health` (or
  `http://claws.default.svc.cluster.local:3000/health` from a pod); compare
  `version` with the release tag cut from the merge, and corroborate with
  `gh pr list --repo St-John-Software/fleet-infra --state all --head automation/bump-claws --limit 3 --json number,title,state,mergedAt`.
  A tag younger than ~25 minutes still rolling out is `deploying`, not failed.
- fleet-infra and production-infra: the latest default-branch apply/reconcile
  workflow run.
- Any other repo: its latest default-branch release or deploy run
  (`gh run list` on GitHub, the Forgejo `actions/runs` endpoint otherwise).
- Docs-, test- or skill-only merges: `n/a` ("no deploy needed").

"Healthy" means `/health` returns `status: ok` on the expected version, or the
deploy run succeeded; say which was checked.

## Unreachable lookups

If a lookup fails, mark that cell `unverified` with the reason. Never guess a
status.

## Fallbacks

Sessions without `claws_*` tools (Codex, OpenCode, browser-capability) use the
`gh` and Forgejo-curl forms above. A Forgejo-canonical repo's GitHub copy is a
stale mirror and is never read with `gh`.

## Report

Header: `Status as of <UTC timestamp> — N items (M need you)`.

One table, columns:

| Item | State | CI | Review | Deploy | Needs |
|---|---|---|---|---|---|

- **Item**: `owner/repo#N` or `#clw_…`
- **State**: stage or PR state
- **CI**: `green` / `red: <job>` / `pending` / `—`
- **Review**: `approved` / `changes requested` / `none` / `—`
- **Deploy**: `deployed vX` / `deploying` / `not deployed` / `n/a` / `unverified`
- **Needs**: `you: Automerge`, `you: approve plan`, `you: manual action <text>`,
  `Claws: implementing`, `blocked: <reason>`, `—`

Then a **Needs you** list: one line per row whose Needs starts with `you:` or
`blocked:`. No narration of what the session did.
