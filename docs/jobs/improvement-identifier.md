# improvement-identifier

**Source**: `src/jobs/improvement-identifier.ts`
**Trigger**: Smart-scheduled (hourly during off-hours)
**Schedule**: Runs hourly during the configured quiet window (default 19:00–07:00 local time). Each tick processes all repos that haven't been processed today. Skips the tick entirely if Claws has active or pending Claude tasks, or running jobs.

Only processes repos that Claws has previously cloned. Repos are processed concurrently.
Single-prompt analysis phase produces both security findings and improvement suggestions,
cutting analysis-phase Claude usage roughly in half compared to two separate jobs.

## Phase 1: Analysis

- Fetches all open issue and PR titles for deduplication context
- Skips analysis entirely if **both** an open `security: ...` issue **and** an open `claws/improve-*` PR exist (both downstream phases would skip — analysis is wasted)
- Creates a transient worktree on branch `claws/improve-<hex4>`
- Instructs Claude to read `docs/OVERVIEW.md` (if it exists) and analyze the codebase for **both** security vulnerabilities and actionable improvements
- Claude responds with structured JSON containing `securityFindings` and `improvements` arrays
- Analysis worktree is cleaned up before implementation begins

The analysis call is `capability: "text-only"` but explicitly pinned to
`provider: "claude"`. This bypasses the default `TEXT_ONLY_PROVIDER_FALLBACK_ORDER`
(OpenCode/Qwen) — Qwen consistently produces malformed JSON for this task,
blocking all downstream phases. Failing visibly on a Claude outage is
preferable to silently producing nothing. This mirrors the provider-pinning
pattern used by the issue-refiner planner.

**JSON parsing robustness**: `parseReviewOutput()` tries three strategies in order to
extract the JSON object from Claude's output: (1) greedy fence match anchored to the
last closing `` ``` `` (handles bodies containing inline code blocks), (2) non-greedy
fence match (fallback when trailing prose follows the fence), (3) brace-balanced
extraction starting at the last `{` before the final `}` (handles unfenced JSON).
Parse failures are reported via `reportError("improvement-identifier:parse-findings", ...)`.

## Phase 2A: File security findings

Security findings are filed first (before improvement implementation). For each finding (up to 5 per run):

- Skipped entirely if any open issue with a title starting with `security: ` already exists for this repo
- Searches existing issues **and PRs** by finding title (skips if a match is found)
- Calls `gh.createIssue` with title `security: <finding title>` (no labels applied)
- Errors in one finding do not block processing of others

Issues include a footer: *"Automated security review by claws improvement-identifier"*

## Phase 2B: Implement improvements

Suggested improvements (up to 10 per run) are implemented **concurrently** via `Promise.allSettled`.
This phase is **skipped** if:
- An open `claws/improve-*` PR already exists for this repo, OR
- At least one security finding was actually filed this tick (security priority lever)

When security findings are filed, improvement implementation is deferred to the next tick.
This ensures operator attention and Claude budget go toward security fixes first.
If security findings are always filed, improvements never run until operators resolve the security issues.

Each improvement:

- Searches existing issues **and PRs** for duplicates (skips if found)
- Creates a fresh worktree on branch `claws/improve-<hex4>`
- Instructs Claude to implement the specific improvement
- If commits were produced: pushes the branch, creates a PR titled
  `refactor: <improvement title>` (no labels applied)
- Errors in one improvement do not block processing of others

Conservative by design: only tangible improvements, no stylistic or
documentation suggestions. "No improvements found" is acceptable.

PRs include a footer: *"Automated improvement by claws improvement-identifier"*

## What it looks for

**Security**: injection vectors, auth/authorization gaps, hardcoded secrets, path-traversal,
SSRF, unsafe deserialization, crypto misuse, secrets in logs, known CVEs, missing input
validation at trust boundaries. Only concrete findings with an exploit path; no
defense-in-depth speculation.

**Improvements**: duplicate/near-duplicate logic, overcomplicated code, dead code,
performance issues, missing error handling at system boundaries, stale TODOs/FIXMEs.
No stylistic changes, type annotations, or documentation suggestions.
