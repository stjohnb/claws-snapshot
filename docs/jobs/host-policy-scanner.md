# host-policy-scanner

**Source**: `src/jobs/host-policy-scanner.ts`
**Trigger**: Via `scanner-dispatcher` (daily schedule)

Flags managed repos whose agent guidance (`CLAUDE.md`, `AGENTS.md`,
`.claude/CLAUDE.md`, or a `.claude/rules/*.md` file) does not document the
automation-host execution policy: no dev servers or long-running processes,
no system-package/browser-binary installs, and never killing a process or
port an agent doesn't own. Added after an incident (2026-08-26, #2637) where
an issue-worker agent freed "its" port with
`lsof -ti:3000 -sTCP:LISTEN | xargs -r kill`, SIGTERM'ing the Claws service
itself (down ~20 minutes), then `sudo apt-get install`ed Playwright system
deps and pulled ~660 MB of browser binaries onto a host already at 80% disk.

## Detection

- Skips repos with no `CLAUDE.md` at all — that's already
  `claude-config-scanner`'s issue; filing both would be duplicate noise.
- Otherwise reads each candidate guidance file that exists (`CLAUDE.md`,
  `AGENTS.md`, `.claude/CLAUDE.md`, every `*.md` directly inside
  `.claude/rules/`) and extracts its automation-host-policy section — the
  heading matching `automation host` / `agent host` / `host policy` /
  `claws host`, up to the next same-or-higher-level heading.
- Three rule regexes (`src/host-policy.ts`) run **only against that
  section**, never the whole file — a repo that documents `npm run dev` and
  `apt-get` in an unrelated CI-toolchain paragraph is not compliant just
  because those words appear somewhere in the file.
- Takes the candidate file with the fewest missing rules; if any file has
  zero missing rules, the repo passes.
- Issue title: `chore: document the automation-host policy for agents`. No
  priority label — this fires across every managed repo on first rollout, and
  a priority label on all of them would swamp triage. It does carry
  `Automerge` (see below).

## Canonical policy block

`src/host-policy.ts` exports `HOST_POLICY_MARKDOWN`, the exact block repos
are told to paste into `CLAUDE.md`, and `HOST_EXECUTION_POLICY`, the prompt
form injected into every agent prompt so the rule holds even in repos whose
docs haven't caught up yet. The `src/agents/*.ts` agents pick it up via
`agent-context.ts`, which re-exports it; job-level agents that build their own
prompts (`doc-maintainer`, `triage-claws-errors`, `improvement-identifier`,
`idea-suggester`, `public-repo-scanner`) import it from `src/host-policy.ts`
directly. Any new call site that runs an agent in a worktree on this host must
include it. Both are
single-sourced from the same module so the block this scanner asks for is
guaranteed to satisfy the scanner itself — verified by a self-consistency
test in `src/host-policy.test.ts`. In this repo the block lives in `AGENTS.md` (its
`CLAUDE.md` is a one-line `@AGENTS.md` include), and `src/host-policy.test.ts` asserts
that copy stays byte-identical to `HOST_POLICY_MARKDOWN`.

## Automerge

The filed issue carries `Automerge`. That label auto-applies `Refined` once
the plan is posted (`isAutoRefineIssue()` in `src/agents/issue-refiner.ts`)
and lets `auto-merger` merge the resulting PR without a human LGTM — the fix
is a mechanical, deterministic edit (a fixed markdown block), so it doesn't
need a human gate. To stop it, disable the job for that repo rather than
removing the label, since the scanner re-adds a missing label on the next
scan (`enforcedLabels`, `src/jobs/scanner-runner.ts`).

## Opting out

If a repo genuinely needs a different policy, disable this check via the
`host-policy-scanner` job-disable config for that repo rather than closing
the filed issue — an open issue with the exact title above is re-filed on
the next scan otherwise.
