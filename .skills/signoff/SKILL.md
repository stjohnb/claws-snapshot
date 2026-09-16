---
name: signoff
description: Check whether this session can end — every problem, follow-up and change raised in the session is resolved or tracked by an open PR or issue — and report a one-line verdict plus a table of loose ends. Use when the user types /signoff, or asks if we're good to end/wrap up/sign off the session.
---

Answer one question the same way every time: **can this session end without
losing anything?** The answer is yes only when every problem, follow-up, or
unfinished change raised in the session is resolved and verified, or tracked
by an open PR or open issue that actually covers it.

The argument, if any, narrows the audit to that subject. `/signoff` with no
argument audits the whole session.

This skill runs in a worktree of whatever repo the session is working on —
never assume a `claws`-repo-relative path exists.

## Phase 1 — Inventory from the conversation

Walk the whole session and list every candidate loose end:

- bugs or failures found, including ones spotted in passing
- deferred review findings
- TODOs and "we should also…" remarks
- workarounds applied by hand instead of fixed in code
- manual actions promised or named in a PR's `## 📋 Manual action required
  after merge` section
- questions the operator asked that were never answered
- every issue, PR, branch and repo the session touched

An item the operator explicitly waved off ("ignore that", "not worth
tracking") is recorded as **dropped by operator** and is not a loose end.

Context compaction can drop earlier detail from the inventory. To recover
what a summary may have dropped, also re-list issues and PRs recently
authored or commented on by the session's own actor:

```bash
gh search issues --author @me --updated ">=<today>"
gh search prs --author @me --updated ">=<today>"
```

## Phase 2 — Local state

For each repo or worktree the session changed, check:

- `git status --porcelain` for uncommitted changes
- commits not on any remote: `git log --branches --not --remotes --oneline`
- stash entries the session itself created, found by its own tag. The stash
  stack is shared with other sessions — never report or drop anyone else's
  entries.
- background commands or tasks this session started that are still running

Any hit is a loose end unless it is intentionally throwaway, in which case
say so instead of listing it as untracked.

## Phase 3 — Check remote tracking

For each inventory item, find the covering open issue or PR and confirm its
text actually covers the item — a similar title is not enough. A closed
issue or a closed-unmerged PR does not count as tracking.

- Both GitHub and Forgejo repos: the `claws_open_prs` MCP tool is
  forge-aware — try it first.
- GitHub repos: `gh issue view`/`gh issue list`, `gh pr view`/`gh pr list`,
  `gh pr checks`.
- Forgejo-hosted repos: the GitHub copy of a Forgejo-canonical repo is a
  stale mirror — never use `gh` for it. Without an MCP tool available, use
  curl against `$CLAWS_FORGEJO_BASE_URL/api/v1` with header `Authorization:
  token $CLAWS_FORGEJO_TOKEN`.
- Multi-PR plans: use the `claws_issue_phases` MCP tool to confirm the
  remaining steps are still tracked by the issue.
- Merged PRs: a merged PR counts as **resolved** only when the session
  verified its deploy, or the change needs no deploy (docs, tests).
  Otherwise it is "merged, deploy unverified" — a loose end. For the
  `claws` repo itself, compare `cat /opt/claws/.current-version` against
  `gh release list -R St-John-Software/claws --limit 3`. For other repos,
  the latest default-branch release/deploy run in `gh run list` is enough.
- An open PR that is waiting on a human (LGTM, a red CI the ci-fixer owns,
  a manual post-merge action) counts as **tracked**, but also goes in the
  "Needs you" list (Phase 4) so the operator sees it before leaving.

## Phase 4 — Report

Use this fixed format and nothing else. No preamble, and no restating of
the session history.

The first line is exactly one of:

- `✅ Good to sign off`
- `⚠️ Good to sign off — N items need you` — everything is tracked, but
  one or more open PRs are waiting on a human
- `❌ Not yet — N untracked`

Then a markdown table with columns **Item**, **Status** (`resolved` /
`tracked` / `untracked` / `dropped by operator` / `unverified`), and
**Where** (`owner/repo#N`, a branch name, or `—`). Leave the table out when
the verdict is ✅ and nothing was touched.

For `❌`, add a numbered list with one proposed issue title and target repo
per untracked item, then one line asking whether to file them, commit or
push, or clean them up. Filing only happens after a yes. When filing, use
the normal issue flow with no "Automated by Claws" footer, and file
Forgejo-canonical repos on Forgejo, never GitHub.

For `⚠️`, add a "Needs you" list with one line per waiting PR, e.g.:

```
- #123 — needs LGTM
- #456 — manual post-merge action: delete the superseded PVC
```

## Fallbacks

Codex, OpenCode and browser-capability sessions have no `claws_*` MCP
tools. Use the `gh` or Forgejo API equivalents above instead of aborting.

If a check cannot be run — for example a forge is unreachable — mark that
item `unverified` in the Status column instead of guessing. The verdict
cannot be `✅` while any item is `unverified`.
