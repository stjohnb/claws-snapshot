---
name: tier2-apply
description: Apply an operator-held tier-2 pull request end to end from a session — SSO device sign-in shown as a clickable link, dry run, apply only after the operator's explicit go, verify `No changes`, always sign out, clear the hold and flag sibling PRs. Use when the user types `/tier2-apply`, or asks a session to apply a tier-2 or operator-applied PR.
---

You may be running inside a worktree of any managed repo, under Claude or
Codex. Never assume a `claws`-repo-relative path exists, and never use `gh`:
every repo is on Forgejo, read through `$CLAWS_FORGEJO_BASE_URL/api/v1` with
`$CLAWS_FORGEJO_READ_TOKEN` and the Claws MCP tools named below.

The PR's own repo owns the apply script and every AWS constant (account,
profile, start URL). This skill only drives that script's session modes
(`--login`, `--dry-run <PR>`, `--confirm-head <sha> <PR>`, `--logout`); it
never writes an AWS profile or names an account itself.

## Rules, for the whole run

- **Never apply without the operator's go.** The go must be an explicit
  message in this conversation, given after you showed the dry run's result
  for the head you are about to apply. A go given before the dry run, or for
  a different head, does not count.
- **Never answer a prompt by timing or piping.** No `expect`, no `script`, no
  `sleep … | ` or `yes |` into a prompt. If the script asks for input in a
  session mode, stop and tell the operator; the script is wrong, not you.
- **Never write, print or copy credentials or the SSO cache.** Do not read
  `~/.aws/sso/cache`, `~/.aws/credentials`, or print `aws configure
  export-credentials` or any token; the only place a credential lives is the
  AWS CLI's own SSO cache, and `--logout` removes it.
- **Never merge the PR.** Merging stays with the operator and the auto-merger.
- **Never run AWS commands the operator did not ask for.** The only AWS
  access is through the script's four session modes above.
- **Always sign out** (step 8) once step 5 has started, whatever happens next.
- **Always run the script from the repo's default branch.** Every mode runs
  from the fresh detached worktree of `origin/<default branch>` made in step
  4, never from the PR's branch or the session's own working tree: the PR's
  copy of the script is unreviewed, and a stale checkout may lack a guard.

## 1. Resolve the PR

The argument is a PR number (`/tier2-apply 36`) or `owner/repo#N`. With a bare
number the repo is the session's: the `owner/repo` path of `git remote get-url
origin`, without any `.git` suffix. No argument: ask which PR and stop.

Call `claws_prs_overview` with that `repo` and find the PR's entry. It must
carry a hold with `hold_kind` `operator-step`; record its
`manual_action_reason`. No entry, no hold, or any other `hold_kind`: say so
and stop — there is nothing for an operator to apply.

## 2. Find the command

Take the backticked command from `manual_action_reason`. If the reason has
none, read the PR description (`GET /repos/<owner>/<repo>/pulls/<N>`, `.body`)
and take the backticked command from its "Manual action required before
merge" block. Replace a literal `<PR>` in it with the PR number.

Refuse, and stop, unless the command matches exactly:

```
nix develop --command ./scripts/<name>.sh <N>
```

where `<name>` is letters, digits, `-` or `_` and `<N>` is this PR's number.
Call `./scripts/<name>.sh` "the script" from here on; every later step runs it
as `nix develop --command ./scripts/<name>.sh <mode…>`.

Tell the operator the changes the hold reason and PR description say to
expect (resources created, changed, destroyed). You compare them with the dry
run in step 6.

## 3. Check the head against CI's plan

With `$CLAWS_FORGEJO_READ_TOKEN`:

```bash
api="$CLAWS_FORGEJO_BASE_URL/api/v1/repos/<owner>/<repo>"
curl -sfH "Authorization: token $CLAWS_FORGEJO_READ_TOKEN" "$api/pulls/<N>" | jq -r '.head.sha, .state'
curl -sfH "Authorization: token $CLAWS_FORGEJO_READ_TOKEN" "$api/issues/<N>/comments" \
  | jq -r '[.[] | select(.user.login == "forgejo-actions")
               | select(.body | startswith("<!-- tofu-plan -->"))
               | select(.body | test("(?m)^Head: [0-9a-f]{40}$"))]
          | sort_by(.updated_at) | last | .body // empty' \
  | sed -n 's/^Head: \([0-9a-f]\{40\}\)$/\1/p' | head -n 1
```

The PR must be `open`. Among the PR's comments (this endpoint returns them all in one response, with no paging), take the
`forgejo-actions` comments whose body starts with the `<!-- tofu-plan -->`
marker **and** has a `Head: <40-hex sha>` line (a repo may post other marker
comments, such as a tier-1 plan, without one), and use the most recently
updated (`updated_at`) of them — CI edits its comments in place, so creation
order says nothing. If a read fails, report it and stop.
Refuse and stop if there is no such comment, or if its sha differs from the
PR's `head.sha`: CI has not planned this head yet, so wait for the Tofu Plan
workflow. Record the head sha.

## 4. Checkout and session modes

Always run the script from the repo's **current default branch**, never from
the PR's branch or whatever the session's checkout is on: the PR's own copy of
the script is unreviewed and would run with admin credentials, and a stale
checkout may lack the session modes or a guard fix. The script checks out the
PR head itself, in its own worktree, so it never needs you on the PR branch.

Read the default branch (`GET /repos/<owner>/<repo>`, `.default_branch`). If
the session's checkout is of the PR's repo (its origin is that repo), make a
fresh detached worktree of it:

```bash
work="$(mktemp -d)/repo"
git fetch origin <default>
git worktree add --detach "$work" "origin/<default>"
```

Otherwise set `work="$(mktemp -d)/repo"` the same way and clone the repo into
`$work` over the already-authenticated Forgejo remote (a clone lands on the default branch).
If you can do neither, say so and stop. Either way, `cd "$work"` and run every
later command from there.

Run `nix develop --command true` in the foreground first, so the devShell is
built before anything that has to be quick.

Run the script with `--help`. If its output does not list all of `--login`,
`--dry-run`, `--confirm-head` and `--logout`, stop and tell the operator the
repo's script lacks session modes (it needs the non-interactive modes before a
session can apply it). Do not fall back to the plain `<PR>` form: it needs a
terminal and a typed `yes`.

## 5. Sign in

```bash
tmp="$(mktemp -d)"
nix develop --command ./scripts/<name>.sh --login >"$tmp/login.log" 2>&1 &
```

Start it in the background (with Claude Code's Bash tool, use its background
mode; under Codex, the `&` form above) and note its pid or task id. Poll
`$tmp/login.log` every few seconds until **either** it has both the first line
starting `https://` and a line matching `^[A-Z0-9]{4}-[A-Z0-9]{4}$`, **or**
the login process has exited — whichever comes first. A login that finds a
valid token already prints only `Signed in to AWS SSO as account …` and exits
0 with no URL or code, so never wait for lines once the process is gone:

- Exited 0 with no `https://` line: already signed in. Report the `Signed in
  …` line and go on to step 6.
- Exited non-zero first: follow the failure path below.
- Both lines appeared: show them to the operator at once, as:

[Sign in to AWS](<the https:// line, whole>)

and on its own line after it, the code alone:

ABCD-EFGH

The URL is long: put it whole inside the link's parentheses, and never in a
code block or backticks, which make it unclickable. Then wait for the login
process to exit. It must exit 0 with `Signed in to AWS SSO as account …`.

If it exits non-zero (the device code expires after a few minutes, or the
operator declined), tell the operator, go to step 8, and rerun step 5 only
when the operator says they are ready — never silently.

## 6. Dry run

Run, in the foreground (`FORGEJO_TOKEN` defaults to
`$CLAWS_FORGEJO_READ_TOKEN`, which the script reads itself):

```bash
nix develop --command ./scripts/<name>.sh --dry-run <N> 2>&1 | tee "$tmp/dry-run.log"
```

- Exit 0 with `both show no changes: nothing to apply.`: the change is
  already live. Go to step 8, then step 9.
- Non-zero exit: report the script's error line, go to step 8, and stop.
- `Dry run: nothing applied. To apply this exact head: --confirm-head <sha>`:
  show the operator the `address action` list (the indented lines after
  `Local plan matches the PR's tier-2 plan comment`), the `Plan:` line, and
  the head sha, beside the expected changes from step 2. Point out any
  difference from what the hold reason or description said to expect.

Then **stop and wait** for the operator. Ask plainly whether to apply head
`<sha>`. Do nothing else until they answer. A "no", or anything that is not
a clear go, means step 8 and stop.

## 7. Apply

Only after the operator's explicit go for the dry run you showed:

```bash
nix develop --command ./scripts/<name>.sh --confirm-head <sha> <N> >"$tmp/apply.log" 2>&1 &
```

with `<sha>` exactly the head the dry run printed. Run it in the background
and poll the log until the process exits; the apply can take minutes. It must
exit 0, and the log must contain the `No changes: tier 2 matches PR #<N>.`
line. Show the operator the apply's summary line and that line.

If it refuses with `PR head is …, not the confirmed …`, the PR moved: tell the
operator, run step 8 to sign out, and restart at step 3 (the operator's go
was for the old head and no longer counts); step 5 then signs in afresh. Any other failure: show the error lines, go to step 8,
and stop.

## 8. Sign out, always

Run this after step 7, and after any failure, refusal or "no" from step 5
onward:

```bash
nix develop --command ./scripts/<name>.sh --logout
```

Report its `Signed out of AWS SSO; no valid token remains.` line. If it exits
non-zero, tell the operator plainly that a token may remain in the AWS CLI's
SSO cache and that they should run `aws sso logout` themselves. Remove `$tmp`,
and once this run is finished, `cd` out of `$work` and remove it (`git worktree
remove --force "$work"` for a worktree, or delete the clone's directory).

## 9. Clear the hold and flag siblings

Only when step 7 verified `No changes` (or step 6 reported nothing to apply),
call `claws_clear_pr_manual_action` with `repo` and `pr_number`. Never clear
it after a failed or skipped apply.

Then call `claws_open_prs` for the repo. The applied root is the directory
the script planned in — the one the hold reason names, or in practice the
top-level directories this PR changed that contain `*.tf` files (e.g.
`tier2/`); never `docs/`, `scripts/` or other directories the PR also
touched. For every other open PR, read every page of
`GET /repos/<owner>/<repo>/pulls/<M>/files?page=<p>&limit=50` (increase `p`
until a page returns fewer than 50 entries) and compare the top-level
directory of each `filename` with the applied root only. Flag every PR
changing the applied root: its
plan predates this apply and would revert it, so it needs a rebase onto
`main` after this PR merges and a fresh plan. Only report them — do not
rebase, comment on or re-plan them.

Finish with one short summary: PR, head applied, the `No changes` result,
sign-out result, hold cleared or not, and the flagged sibling PRs.
