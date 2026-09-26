# Key Patterns

**Reference.** Full detail behind each pattern indexed in OVERVIEW's Key
Patterns list. Read a pattern here when you need its edge cases or rationale,
not just its name.

### Content-Based State Machine

Issues and PRs are discovered by analysing comments, reactions, and PR state —
not labels. Fifteen labels are used:

- `Refined` — trigger for issue-worker (only label that drives a state transition)
- `Ready` — informational, signals "Claws is done, your turn"
- `Priority` — high-priority items processed first in all Claws queues
- `Duplicate` — issue has been identified as a duplicate; issue-dispatcher skips it in both the planner and implementer phases; canonical issue's last-phase PR auto-closes duplicates via `Closes #N`
- `Backlog` — parked for later by a human (#3293): off the board, listed on `/backlog`. `hasBacklogLabel()`/`isParked()` (`src/github.ts`) treat it exactly like `Blocked`, so every dispatch-skip check and the issue-auditor leave it alone. The difference is who unparks it: nothing automated ever removes `Backlog` (`upstream-watcher` removes only `Blocked`/`Claws Ignore`) — only a human promotes it back to Ideas or Planning, where the dispatcher's plan-hash check decides whether an existing plan still stands. It outranks every other state label in `STATE_LABELS`, so a forge issue holding it plus `Refined` is still parked. See [issue-tracker.md#backlog](issue-tracker.md#backlog)
- `Blocked` — parked on an external precondition (an upstream release, another repo's PR, a delivery) rather than abandoned. Added (#2652) because `Claws Ignore` was the only park label and meant "never touch this", so a genuinely-blocked issue either sat invisible forever or, if left `Ready`, showed up in the human's daily review pile with nothing actionable to do. `hasBlockedLabel()`/`isParked()` (`src/github.ts`) treat `Blocked` as equivalent to `Claws Ignore` everywhere dispatch-skip is checked (`isDispatchSkippable`, the CI-fixer/auto-merger sweeps, issue-auditor — critical, or the auditor would re-add `Ready` and undo the park); duplicate-detection candidate lists are the deliberate exception, since a blocked issue is still a valid duplicate target. issue-refiner applies it itself when the planner reports `blocked` through `claws_report_outcome` (see [Planner output via MCP tools](#planner-output-via-mcp-tools) below); [upstream-watcher](jobs/upstream-watcher.md) is the primary consumer, applying it to park an issue on an external condition and removing it (plus any legacy `Claws Ignore`) once that condition fires
- `Claws Ignore` — causes all Claws jobs to skip the item entirely (label-based complement to `skippedItems` config)
- `Claws Problematic` — PR has exceeded CI fixer circuit breaker thresholds and requires manual intervention
- `Billing` — applied by ci-fixer when a workflow run's annotations indicate a GitHub Actions billing/spending-limit block; rerun is skipped for these PRs
- `Plan: Deep` — causes issue-refiner to plan on the selected provider's best model at maximum reasoning effort instead of the default opus tier; per-issue opt-in for deep planning. It does **not** pin a provider.
- `Use Claude` / `Use Codex` / `Use OpenCode` — per-item provider override. `getProviderSelectionForItem()` (`model-selector.ts`) reads these off the triggering issue/PR's labels and pins the run with `strictProvider: true` when that provider is enabled with a positive weight; a disabled/zero-weight label is ignored with an attribution note, and conflicting provider labels fall back to weighted selection. Automated MCP-required prompts use the same provider-label and weighted-selection semantics because Claude, Codex, and OpenCode runs all receive `mcpConfig`. See [configuration.md](configuration.md) and [claws-automation.md](claws-automation.md) for the full precedence rules
- `Manual Action` — applied by issue-worker only when the PR-description generator emits a `MANUAL-ACTION-BEFORE-MERGE:` marker (or a bare legacy `MANUAL-ACTION:`); blocks auto-merger until a human removes it (#1887). A `MANUAL-ACTION-AFTER-MERGE:` marker instead renders a `## 📋 Manual action required after merge` section in the PR body, applies no label, and is announced by auto-merger as a PR comment plus Slack ping at merge time (#2620). Either marker is dropped entirely — no section, no label — when `isVerificationOnlyAction()` in `issue-worker.ts` judges the note pure verification/observation ("verify the alert fires", "monitor the dashboard") rather than a required state-changing step no automation can perform (#2644)
- `Automerge` — opt-in per issue (one-click from the Claws `/prs` and `/issues` pages); propagated by issue-worker onto the PR it opens. On a PR it is the approval auto-merger requires (#3135), and it carries its own automated gate: the latest Claws `## PR Review` must be `clean` **and** must have reviewed the current HEAD SHA, and CI must be `passing` (a `none` check status is only accepted once the head has settled). `Manual Action` still blocks the merge (#2120)

**Owner requirement — manual actions must be genuinely required.** #2644: too many PRs were carrying `MANUAL-ACTION` sections for steps the owner was never going to do (e.g. "verify the new Gatus check and Grafana alert rules fire/clear correctly" — pure post-deploy observation, not a state change only a human can make). `isVerificationOnlyAction()` exists specifically to keep that class of note from generating a label or a body section at all — see the `Manual Action` bullet above.

For approval-exempt dependabot/doc/ideas PRs, auto-merger accepts a `none` check status only once the head commit is at least 5 minutes old, so a head pushed seconds earlier — whose check runs have not registered yet — is never mistaken for a repo with no CI (#2354). After that settle window, a `none` status on any PR is also allowed to carry forward: `carriedForwardCheckStatus()` (`src/github.ts`) walks the PR's own commits back from the head and, if every commit down to the newest one that actually ran CI touches only CI-exempt paths, treats that ancestor's rollup as still describing the head — so a docs-only advisory self-fix on a code PR doesn't strand it with an empty rollup and no `Ready`/merge (#2929)

```
Issues (issue-dispatcher):
  No plan comment        →  (planner posts plan)         →  Ready label added
  Unreacted feedback     →  (planner refines plan)       →  Ready label re-added, response comment posted
  Open PR + follow-up Q  →  (planner posts response)     →  👍 reactions added (no label changes)
  Refined label          →  (implementer creates PR)     →  Refined removed, Ready removed, claws_prs row linked to the issue
  [claws-error] title    →  (triage-claws-errors)        →  investigation report posted
  Plan occurrences stale →  (planner re-plans in-place)  →  CLAWS_PLAN_OCCURRENCES marker updated (fires when currentOcc ≥ plannedOcc×2)
  No code change needed  →  (planner posts explanation + writes {"verdict":"no_code_changes"})  →  Claws Ignore label applied; pipeline short-circuits, issue stays open

PRs (pr-dispatcher):
  Empty PR (0 files changed, >10 min old)  →  (empty-pr-closer)  →  comment posted, PR closed; linked issue closed only if a PR for it already merged
  Dependabot PR (Problematic, tracking issue closed, all bumps satisfied-or-blocked on base)  →  (superseded-pr-closer)  →  comment posted, PR closed
  All open PRs               →  (reviewer)           →  review comment posted, Ready added if clean
  "/claude-review" comment   →  (reviewer)           →  re-review forced via Claude (bypasses OpenRouter for one cycle)
  Failing CI checks          →  (ci-fixer)           →  fix commits pushed or workflow rerun
  Merge conflicts            →  (ci-fixer)           →  conflicts resolved
  Reviewer feedback (auto)   →  (review-addresser)   →  🚀 reactions added, commits pushed → reviewer re-reviews
  Human review comments       →  (review-addresser)   →  🚀 reactions added, reply posted + Ready added if no commits pushed
  Dependabot (`dependabot[bot]` or `app/dependabot`) or Automerge-labelled PR with a clean review of the head + passing CI  →  (merger)  →  merged, native issues its body closes are closed
  Doc PR (claws/docs-*) + doc-only files + CI passing/skipped  →  (merger)  →  merged (no Automerge required)
  Idea-collection PR (claws/ideas-collect-*) + ideas-only files + CI passing/skipped  →  (merger)  →  merged (no Automerge required)
  Auto-bump PR (automation/bump-*, label auto-bump, no major-update) + yaml-only diff containing nothing but image-pin re-pins (image:/newTag:, same image, new tag/digest) + CI passing  →  (merger)  →  merged (no Automerge required)
```

**Plan length warning**: After posting any plan comment (fresh plan,
refinement, or follow-up), the issue-refiner checks the output length against
`PLAN_LENGTH_WARN_CHARS` (18,000 chars). If exceeded, it posts an additional
GitHub `> [!WARNING]` callout comment — a yellow alert box in the GitHub UI —
advising that the plan is well above the concise planning target and offering to
re-plan more concisely. `IMPLEMENTER_GUIDANCE_INSTRUCTIONS` asks the planner for
under about 1,500 words and quotes the 18,000-character limit directly (the prompt
interpolates the constant, so the two numbers cannot drift apart). A typical plan
of about 1,500 words with paths and code fences comes to roughly 8–10k characters,
so the warning sits at about double the target and fires only on real outliers. It
is an after-the-fact operator signal, not enforcement.

**Duplicate issue detection**: During fresh planning (`processIssue`), the
issue-refiner injects up to `MAX_DUPLICATE_CANDIDATES` (20) lower-numbered open
issues as "possible duplicate candidates" into the planner prompt. The planner
reports a duplicate by calling `claws_report_outcome` with `outcome: "duplicate"` and
`duplicate_of: N` (see [Planner output via MCP tools](#planner-output-via-mcp-tools) below) —
never in its prose, which is posted verbatim. If a duplicate is
declared, the new issue receives a short "See #N" plan instead of a full
implementation plan, and a back-reference comment is posted on the canonical issue.
The duplicate issue also receives the `Duplicate` label, and the plan comment embeds
a plain-text `CLAWS_DUPLICATE_OF: #N` marker (never an HTML comment — consistent
with `NO_HTML_COMMENTS_INSTRUCTION` injected into all planner prompts). The issue-dispatcher then skips
`Duplicate`-labeled issues in both the planner and implementer phases. When the
canonical issue is implemented, the issue-worker calls `listDuplicateIssuesOf()` on
the last phase and appends `Closes #N` entries to the PR body for each open duplicate,
so all related issues are closed when the PR merges. Tiebreaking is deterministic:
lowest issue number wins (important when a cluster of alert issues is created in
parallel). `submitOutcome()` (`src/planner-runs.ts`) validates the
declared number against the candidate list to prevent hallucination — a number that
was not offered is rejected with a tool error naming the candidates, so the agent
corrects it or saves a plan instead. Candidate titles
and bodies are run through `guardContent()` before being injected. This scope is
restricted to fresh plans only — refinement and follow-up paths are not affected.

**Cross-repo issue transfer** (#2216): During fresh planning, if the planner judges
an issue obviously mis-filed, it can report `outcome: "transfer"` with `transfer_to: "owner/repo"`
through `claws_report_outcome` (see [Planner output via MCP tools](#planner-output-via-mcp-tools) below), naming
another repo owned by the *same* GitHub owner as the current one — candidates come
from `selectTransferCandidates()`, which lists all other same-owner managed repos
(capped at `MAX_TRANSFER_CANDIDATES`, 30). A run records at most one outcome (the last call wins), so
transfer, duplicate, blocked and no-code-changes are mutually exclusive by construction
rather than by precedence rules; it is disabled per-process via `CLAWS_PLANNER_TRANSFER=false`
and skipped entirely if the issue already carries a `CLAWS_TRANSFERRED_FROM:` stamp
naming a *different* repo than the current one (`alreadyTransferredInto()`) — one
hop only. The routing comment posted before the transfer uses its own
`## Repository Transfer` header (`TRANSFER_HEADER`), **never** `PLAN_HEADER`
(`## Implementation Plan`) — every "has this issue been planned?" check in the
pipeline (`findUnreactedFeedbackAfterPlan`, `work-handlers.ts`, `plan-parser.
findPlanComment`) tests for `PLAN_HEADER`, and GitHub carries comments across a
transfer, so a `PLAN_HEADER` here would make the destination treat the issue as
already planned and never re-plan it (a design flaw caught and fixed before merge —
see the `## Step Back` critique on #2216). The model's rationale text is passed
through `.replaceAll(PLAN_HEADER, "Implementation plan")` before posting, so a
stray `## Implementation Plan` string inside the model's own prose can't
accidentally re-trigger the same hijack. A stale `Ready` label is removed before
transferring (so the destination doesn't inherit a "Claws is done" signal), and
`gh.transferIssue()` failure falls back to a `Claws Ignore` label plus a comment
asking the human to move the issue manually — the `CLAWS_TRANSFERRED_FROM:` stamp
is only posted alongside a transfer attempt, so a failed transfer never poisons
routing in the (wrong) source repo forever.

**Planner output via MCP tools**: <a id="planner-output-via-mcp-tools"></a><a id="planner-verdict-file"></a>Every
planner invocation — a fresh plan, both refinement paths and the step-back pass — hands
Claws its result through a Claws MCP tool rather than through files or prose. The
refiner opens a **planner run** for each invocation with `withPlannerRun()`
(`src/planner-runs.ts`): a random UUID mapped to the issue, the stage (`plan`,
`refine` or `step_back`) and the allow-lists the prompt offered. `writeAgentMcpConfig`
bakes that id into the invocation's own config file (`plannerRun` plus a `fileSuffix`,
so the plan and step-back configs in one worktree do not overwrite each other), and
`mcp-server.ts` registers the planner tools (`src/planner-tools.ts`) only when
`CLAWS_MCP_PLANNER_RUN_ID` is set. The id is the only handle the tools have, so an agent
cannot write to any other issue; session pods (`claws-state-http.ts`) never get them.
The run's allowed repos are a native issue's repos (`plannerAllowedRepos` in
`agents/issue-refiner.ts`), or the acting repo alone for a forge issue; for an issue
with several, the prompt lists them and says each PR may be in any of them, in merge
order.

- `claws_save_plan` takes the plan text, the PR list the plan needs (`prs`: one
  `{repo, title}` per `### PR N:` section, in merge order), `implementation_model`,
  `review_model`, an optional `target_pr` and — refine stage only — a `response` to
  the feedback.
- `claws_report_outcome` takes `duplicate` / `transfer` / `blocked` / `no_code_changes`
  plus a required `explanation`. `duplicate` and `transfer` are offered only when the
  prompt section that makes them legal was injected ("Possible Duplicate Candidates",
  "Repository Routing"); a refinement run is plan-only and rejects every outcome.
- `claws_step_back_verdict` (step-back stage only) takes `sound` / `reconsider`, a
  critique and an optional complete `revised` plan with the same fields.

Each call goes to `POST /api/planner-runs/:id/{plan,outcome,step-back}` (internal token,
404 for an unknown or finished run), served by whichever process holds the run registry:
the service for an in-process run, or — under `CLAWS_WORK_BACKEND=k8s-pod`, where the
refiner runs inside the agent pod — the pod's own loopback listener
(`src/planner-run-listener.ts`), whose URL `agent-pod/run.ts` hands to the MCP config
writer as `CLAWS_PLANNER_RUN_BASE_URL` and the child receives as
`CLAWS_MCP_PLANNER_BASE_URL` (#clw_01M3A42ZTGECAB11S0BZA6NG1A). Only the planner tools
use that URL; the service's copy of the routes never knows a pod's run and would answer
404. `submitPlan` / `submitOutcome` / `submitStepBack`
validate it — a `prs[].repo` outside the issue's repos, a `prs` count that differs from
the plan's `### PR N:` sections (a plan with none counts as one), an unknown model,
`target_pr` on a multi-PR plan, a duplicate that was not offered, and a plan and an outcome in the same
run are all rejected with a precise message — and the tool returns that message so the
agent can fix it and call again. A valid call is recorded on the run; the last one wins.

**Nothing is published from the tool.** The refiner reads the run's submission after the
CLI exits, then posts: `renderPlanBody()` turns the fields back into today's comment
text (the two `**Recommended … model:**` lines and `CLAWS_TARGET_PR: #N` on the last
line), so plan-parser's readers are unchanged, and the refinement `response` goes to the
existing reply-comment path. Only after the plan comment is posted or edited does the
refiner write the PR list with `replaceIssuePlannedPRs` (see
[Multi-PR Phase Coverage](#multi-pr-phase-coverage)) — the step-back revision's list when
there is one. A timed-out or withheld run therefore never leaves a half-published plan.
A run that saved no list keeps the stored one when its length still matches the new
text's `### PR N:` count — its PR links cannot be rebuilt once deleted — and clears it
otherwise, warning about any linked entry it drops.

**Silence is never an outcome.** With no submission the plan text falls back to the CLI's
final assistant message, with no PR list, and a warning is logged. The fallback is only
for a planner that never used the tools: every rejected call is counted on the run
(`getRunRejections`), and a plan or refine run whose calls were all refused fails
instead — its final message is a complaint about the refusal, not a plan, and must not
reach `Ready` (#clw_01M3A42ZTGECAB11S0BZA6NG1A); a step-back pass in the same state
warns and keeps its text-marker fallback. That text loses any
`CLAWS_TARGET_PR:` line (only the `target_pr` field may set one), and in the refine stage a
trailing `### Response` section is split off as the reply. A fallback shorter than
`MIN_PLAN_CHARS_WITHOUT_MODEL_LINE` with no model line is treated as degenerate and retried
once in a fresh run. A duplicate, transfer or park is only ever applied on an explicit
`claws_report_outcome` call, and step-back without a tool call falls back to the
`STEP_BACK_VERDICT:` / `STEP_BACK_REVISED_PLAN` text markers its prompt names for when the
tool is unavailable, where an absent marker means "sound". Because the
outcome never travels on the prose channel, a plan may quote, name and discuss any
outcome or legacy marker freely without triggering one — the root cause behind #3046 and
#3154, first fixed by the verdict file (#3155) these tools replaced.

`runClaude`'s file channels (`src/claude.ts`) are unchanged: `useOutputFile` is still used
by the PR reviewer, and `verdictFile` is kept only as a generic option — no agent passes it
since the planner moved to these tools.

Jobs track processed items via reactions on comments: the issue-refiner uses
👍 to mark seen comments, while the review-addresser uses 🚀 to mark
addressed review feedback. Human review comments are processed automatically;
Claws-authored suggestions require a human 👍 before implementation.

**Automated review-implement cycle**: Claws PR reviewer comments with
actionable feedback (`## PR Review` containing issues) are automatically
picked up by the review-addresser without requiring a human 👍 — this
creates a fully automated review → fix → re-review loop. Clean reviews
("no issues found" / "no net changes") are excluded from auto-addressing.
Non-review Claws comments still require human 👍. Text output rules for the
review-addresser: (1) if a review comment asks a **question** (e.g. "why did
you…", "what about…", "can you explain…"), the agent MUST post a written
answer — even when a code commit also addresses it; answering only with a
commit is not acceptable; (2) if a suggestion couldn't be implemented or an
error occurred, the agent explains in text; (3) if every comment was a pure
change request fully addressed by commits (no questions, no problems), the
agent posts no comment. The `Ready` label is added when a text reply is
posted without any commits. When only commits are pushed (no questions
asked), no comment is posted and `Ready` is not added — the reviewer
re-reviews in the same dispatcher cycle. This prevents `Ready` from
flickering on/off between cycles.

**Benign no-change output** (`isBenignNoChangeOutput`, exported from `review-addresser.ts`): when the addresser made no commits but produced text output, the guard distinguishes benign "already addressed / not applicable" confirmations from real blockers. A positive "no change needed" phrase is required AND no blocker/error/uncertainty signal may be present. When the guard returns `true`, `Ready` is applied (with a CI/merge-state re-check mirroring the pr-reviewer path) rather than withheld — fixing the case where a false-positive reviewer nit produces confirmation text that previously caused PRs to stall permanently (the `review-addressed: <SHA>` marker prevents the addresser from re-firing, and without a push there are no new commits for the reviewer to detect).

**Human-over-automated authority**: When human and Claws reviewer comments conflict
(e.g. a human directs "use self-hosted runner" but the automated review says "use
ubuntu-latest"), the review-addresser's prompt explicitly instructs it to follow the
human and ignore the conflicting automated comment. The authority hierarchy — established
by the `getPRReviewComments()` section headers — means human directives cannot be
silently overridden by the next automated review cycle.

**Refined plan is authoritative over the original issue**: `buildIssueContext()`
in `src/agents/pr-reviewer.ts` fetches both the originating issue body and the
Claws refined-plan comment (if one exists, via `planParser.findPlanComment()`).
When a plan comment exists, the reviewer is told the **refined plan**, not the
original issue text, is the authoritative spec — the planner may have
deliberately narrowed, expanded, or changed the original request after
investigation, and the reviewer must not flag that intentional divergence as a
"missing requirement" or "scope drift". The original issue body is still
included, but only as background on the user's initial intent. When no plan
comment exists, the issue body remains the sole source of truth (unchanged
behavior). This prevents the reviewer from forcing a PR back toward a
requirement the plan explicitly rejected (e.g. issue #1792 asked for an in-app
OIDC allowlist; the refined plan concluded it was unnecessary because
authorization is already enforced upstream in Authentik — see the auth
discussion above — and the reviewer must accept that narrower scope).

**`review-result: clean` marker**: When the pr-reviewer posts a "no issues found"
review, the review body includes a plain-text `review-result: clean` marker (in addition
to the human-readable text). `maybeAddReadyLabel()` uses this marker as its primary
detection signal (with a regex fallback for older reviews that predate it), eliminating
fragile text-matching on body content that may have accumulated formatting drift.
`extractCurrentReviewContent()` strips the marker before content comparisons, and also
strips the `review-addressed: <SHA>` marker written by the review-addresser (preventing
it from leaking into content comparisons).

`isNoActionableReview(output)` catches a related edge case: re-reviews whose verdict is
"no actionable changes" phrased conversationally (e.g. "no changes needed", "the review I
already posted is accurate") without the exact `review-result: clean` marker. These are also
classified as clean so the `Ready` label is applied. The helper returns `false` if the review
carries any actionable signal (file/line references, backticked paths, `Suggested Approach
Change`, `recommended-model:` annotation) to prevent false positives.

The pr-reviewer also includes a **reassessment mechanism**: after
`REASSESSMENT_THRESHOLD` (3) previous reviews with substantive issues,
the reviewer prompt includes the last 5 rounds of feedback and asks Claude
to reassess whether the current approach is fundamentally sound, or whether
a different approach would avoid recurring issues entirely. If so, the
review leads with a "Suggested Approach Change" section.

Triage jobs check for existing report comments.
The issue-auditor reconciles label state daily, adding missing `Ready`
labels; an open PR is read from `claws_prs`, not a label.

### SQLite-Backed Work Queue

Dispatcher jobs (`issue-dispatcher`, `pr-dispatcher`) classify items and
`enqueue()` work into the `work_queue` SQLite table via `worker.ts`. Up to
`MAX_WORK_WORKERS` (default 2) worker fibers run concurrently; each claims the
next `queued` row via `claimNextWork()`, invokes the registered handler, and
marks the row `completed` or `failed`. One further express fiber always runs
on top of that count and claims only `priority = 1` rows, so a Priority or
incident-labelled item starts at once even while every regular fiber is busy.

A queued row is a *candidate*, not a decision. `claimNextWork()` orders by
three keys, in SQL so SQLite and Postgres (`FOR UPDATE SKIP LOCKED`) share one
order and `/queue`, `/api/runtime/status` and `claws_work_queue` list rows in
claim order:

1. **`priority DESC`** — any item labelled `Priority` or an incident label
   (`grafana-alert`, or a repo's `claws.json` `incidentLabels`) beats every
   non-Priority item, whatever stage either is in.
2. **Stage rank ASC** (`src/work-order.ts`), nearest to merge first:
   0 `auto-merger:sweep`; 1 `ci-fixer:conflict`, `ci-fixer`, `ci-fixer:rerun`,
   `ci-fixer:problematic`; 2 `review-addresser`; 3 `pr-reviewer`;
   4 `issue-worker:continue`; 5 `issue-worker`; 6 `issue-refiner:refine`,
   `issue-refiner:replan`, `issue-refiner:followup`, `escalation-reviewer`;
   7 `issue-refiner:plan`; unknown kinds 99.
3. **`id ASC`** — age breaks ties inside a stage. Age does not cross stages, so
   a steady stream of PR-side work can hold both workers while plans wait;
   that is the intended trade for getting open PRs merged first.

The Priority flag tracks the live label: dispatchers re-enqueue every
discovered item each tick, and `enqueueWork()` on an already-`queued` row
updates its `priority` to the caller's current flag (running rows are left
alone). Immediately before the handler runs, `runRow()` re-validates the
claimed item with one uncached forge read (`getPRMergeGate` for PR kinds,
`getIssueState` for issue kinds; repo-scoped kinds are not re-read). A merged,
closed, parked or config-skipped item is dropped without spawning an agent —
the row is marked `completed` with `error_message = "skipped: <reason>"` and a
log line says why. A failed live read fails open (the handler's own checks
still apply) except `RateLimitError`, which takes the normal `rate-limited`
failure path. The concurrency
limit is configurable via `maxWorkWorkers` in `config.json` or the
`CLAWS_MAX_WORK_WORKERS` env var (`maxClaudeWorkers` / `CLAWS_MAX_CLAUDE_WORKERS`
are deprecated aliases). Idempotency is enforced by a UNIQUE partial index on
`(kind, repo, item_number) WHERE status IN ('queued', 'running')` — a second
`enqueue()` for the same item no-ops silently.

With `CLAWS_WORK_BACKEND=k8s-pod` a fiber does not run the handler itself: it
claims with a fresh run id, opens the `work:<kind>` job run, and hands the row
to `agent-pod-launcher.ts`, which records `agent_pod` and the per-run MCP
token hash, creates the `claws-agent-<rowId>` Secret and Pod, and watches it
every 15 s. The pod runs the unchanged `runRow()` (re-validation included)
through the agent-pod ops API (`agent-pod-ops.ts`), never the database. A restart leaves the pod and its `running` row
alone — `recoverWorkOnStartup()`, `reapStaleRunningWork()` and
`getOrphanedTasks()` skip pod-backed rows — and at boot fibers re-attach to
every pod-backed `running` row before claiming new work. The launcher ends a
row only when the pod exited while the row was still `running`, the pod was
gone past the launch grace (an adopted row is re-queued instead), the run was
cancelled, or the row outlived `STALE_RUNNING_WORK_MS`; a Kubernetes API error
never ends one. See [k8s-cutover.md](k8s-cutover.md#pod-per-run-headless-agents-clw_01m34r5recdppxvxbjzs1da6c1).

Each Claude process spawned by a handler has a configurable timeout
(`claudeTimeoutMs`, default 6 hours) with SIGTERM/SIGKILL escalation. Per-item
overrides can extend this for items that have timed out before (see Per-Item
Timeout Escalation below). A 5-minute heartbeat logs PID, elapsed time, and
stdout byte count. A configurable **liveness abort** (`claudeLivenessTimeoutMs`,
default 6 hours) kills processes that produce zero stdout bytes early. A per-worker **memory watchdog** additionally samples each Claude/Codex/OpenCode process tree's RSS every 15s and SIGKILLs the whole tree (children included — e.g. a runaway `openscad` render) when it exceeds `agentWorkerMemoryMaxBytes` (default 2 GiB; deprecated Claude-named aliases are still read; `0` disables), throwing `AgentMemoryLimitError`. In containers, Claws also derives a shared headless-agent admission budget from the cgroup memory limit minus `agentWorkerMemoryHeadroomBytes` (default 1.25 GiB, the service's own footprint), unless `agentWorkerMemorySharedBudgetBytes` is set explicitly; a headroom that swallows the container limit clamps the budget to the cap and warns instead of silently disabling admission. A run reserves its effective cap before spawning, and the reservation and the watchdog cap are always the **same number**, so the sum of live reservations is an upper bound on the RSS the watchdogs tolerate. The gate has **two lanes**: agent-scale runs draw from `budget - AUXILIARY_AGENT_ADMISSION_BYTES`, and short bookkeeping calls draw from the 768 MiB auxiliary lane, each with its own FIFO queue — so a PR-description call never queues behind an implementer. A call is auxiliary when it passes a positive `admissionBytes`, or when it is derived to be one: no `memoryMaxBytes` and no `mcpConfig`, plus either an own timeout ≤ 10 min or a deny-list covering all of `TEXT_ONLY_DISALLOWED_TOOLS`. A *partial* deny-list is not evidence — it sandboxes without bounding footprint. An auxiliary run is *capped* at its slice (and clamped to the auxiliary lane, and floored at 64 MiB), so overrunning it is a diagnosable `memory-limit` kill rather than a silent over-commit; the smaller cap applies only while admission is actually active, since with no budget to protect it would be a pure regression. At the deployed 10 GiB container / 4 GiB cap the 8960 MiB budget admits two overlapping full-cap runs plus one auxiliary call; a third full-cap run waits. The watchdog cap and the admission reservation only diverge when the watchdog is off: `agentWorkerMemoryMaxBytes=0` plus an explicit shared budget still admits, and an uncapped run reserves its per-call `memoryMaxBytes` if it has one, otherwise the whole budget, so it runs alone. A single cap larger than its *lane* budget is admitted only with the whole gate empty and then holds both lanes closed until it releases, with a `log.warn` emitted once per policy (not only on contention), rather than deadlocking or overcommitting the container. A run queued in the gate is registered before it waits, so `/cancel` and `/logs/:runId/cancel` drop the waiter and reject it with `ShutdownError` before any process is spawned; a waiter admitted after `isShuttingDown()` became true is rejected with `ShutdownError` instead of spawning onto a terminating pod. `reloadConfig()` retunes the live gate in place, so raising the budget unblocks a queue that is already parked. The Claude CLI is spawned with `NODE_OPTIONS=--max-old-space-size=1024` (512 for auxiliary runs, whose cap is smaller) to keep its V8 heap footprint deterministic under the cap. After 3 consecutive memory-limit kills at the same effective cap in a 2-hour window, the item is auto-skipped (via `gh.skipItem`) and a comment is posted explaining the skip; below that threshold a comment is posted and the item re-queues normally. Old failures at a lower cap do not count against a later higher-cap policy. Watchdog kills classify as `memory-limit`; an external SIGKILL/SIGTERM that Claws did not initiate, and that did not arrive while the service was shutting down, classifies as `external-kill`, carries the run's admission numbers (container limit, shared budget, headroom, bytes reserved) into the alert, and points operators toward pod events, restart counts, and OOMKilled history. `external-kill` is a `PRE_WORK_FAILURE_CATEGORIES` member, so an eviction mid-run does not burn a ci-fixer or conflict-resolution attempt. All liveness, timeout, and memory kills reap the entire process tree, not just the CLI process. `runClaude`
wraps `runClaudeOnce` with a retry layer (gated on `!isShuttingDown()`) that
retries once on: (1) 0-byte timeouts (transient hang recovery), (2) `AgentCliError`
with `numTurns === 0` (transient CLI initialization failure), or (3) `AgentCliError`
matching `API_TRANSIENT_RE` (Anthropic API 5xx errors, unexpected socket closures,
mid-response connection failures, and OpenCode/OpenRouter hollow completions — a JSON
event stream with token/cost data but no final `text` part). Non-0-byte timeouts and CLI
errors with turns > 0 that don't match the transient API pattern are not retried.
The stdin pipe has an error handler to prevent unhandled stream errors. Timed-out
processes throw `AgentTimeoutError` with diagnostic fields, surfaced in error
reports for debugging. CLI-level failures (usage limits, auth errors, malformed
output) throw `AgentCliError` — usage-limit errors are suppressed by the error
reporter; other CLI errors create `[claws-error]` issues normally.

### Model Selection

`model-selector.ts` provides `getModel(defaultTier, provider)`. Four tiers
exist: `"haiku"` (trivial tasks), `"sonnet"` (standard), `"opus"` (complex), and
`"fable"` (the best each provider offers — deep planning, or an operator
escalation). `"cheap"` was the old name for `"haiku"` and is still read on every
input path via `normalizeTier()`, which is the only sanctioned way to parse a
tier out of model output, a PR marker or a config file.
Most call sites pass the tier explicitly; `"sonnet"` is the default. The PR
reviewer embeds a `recommended-model: sonnet` or `recommended-model: opus` marker
(plain text) in its review output, and the review-addresser extracts it to choose
the appropriate tier.
Per-provider model mapping lives in one place — `MODEL_TIER_TABLE` in
`model-selector.ts`, which the config page renders as a tier table. Claude uses
`CLAUDE_CHEAP_MODEL` / `"sonnet"` / `"opus"` / `CLAUDE_FABLE_MODEL`; Codex normally
omits `-m` and lets the Codex CLI choose the
authenticated account's supported default, unless `CODEX_CHEAP_MODEL` /
`CODEX_LIGHT_MODEL` / `CODEX_DEFAULT_MODEL` / `CODEX_FABLE_MODEL` pins a non-empty ID; OpenCode uses
`OPENCODE_CHEAP_MODEL` / `OPENCODE_ADEQUATE_MODEL` / `OPENCODE_BEST_MODEL` / `OPENCODE_FABLE_MODEL`.
Empty-string overrides are handled: if `CLAUDE_CHEAP_MODEL` is `""`, the haiku
tier falls back to `"haiku"` (a valid Claude CLI alias, cheaper than sonnet), and
an empty `CLAUDE_FABLE_MODEL` falls back to the `"fable"` alias;
empty Codex model keys mean provider default. Stale Codex aliases resolve to
that default, and non-empty Codex pins are validated against `codex debug
models` when available; visible catalogue upgrades are followed, hidden/absent
IDs fall back to default, and runtime unsupported-model failures trip the
provider cooldown/fallback path.
The model used for each task is recorded in the `model_used` column, and the
provider used is recorded in the `provider_used` column, both via `db.ts`. The
provider value is the backend that *reported the usage*, not the one initially
selected — so a run reselected from Claude to OpenCode after a provider outage
is attributed to OpenCode, the backend that actually spent the tokens. An OpenRouter
model ID doesn't pin the upstream host that served the request, and OpenCode doesn't
expose that host, so Claws can only attribute outcomes by backend and requested model.
To investigate a bad OpenCode/OpenRouter run, use the OpenCode session ID and, on
errors, the OpenRouter generation ID — both logged per attempt (see `claude.ts` above).

The issue-refiner (planner) recommends a model tier per issue via embedded
annotations in the plan comment. Provider selection is not part of the plan:
eligible unpinned tasks draw from `aiProviders` using weights, defaulting to
Claude:Codex:OpenCode = 4:2:1. Automated workflows that must use MCP tools can
run on any eligible provider; Claude-CLI-only restrictions stay pinned to Claude. Text-generation workflows
split into two groups:

- **Pinned to Claude** (explicit `provider: "claude"` on the `runClaude` call):
  email-monitor (both veg-list extraction
  and recipe generation, pinned to avoid OpenRouter 402 credit errors), whatsapp-handler message interpretation (pinned for the same reason, #2151), and the
  PR description/diagnosis utilities in `claude.ts` (`generatePRDescription`,
  `generateDocsPRDescription`, `regeneratePRDescription`, `diagnoseNoCommits`).
  These are pinned for output quality, structured-JSON correctness, or reliable
  auth — Qwen via OpenCode/OpenRouter consistently produces malformed JSON for
  analysis tasks, blocking all downstream work.
- **Pinned OpenCode analysis**: improvement-identifier's analysis
  phase runs on OpenCode via OpenRouter using `improvementIdentifierModel`
  (default `openrouter/z-ai/glm-5.3`, chosen for its 1.3M-token context and
  131k-token output ceiling — not a `qwen/*` model, which is the family that
  produces malformed JSON for this task). This is an explicit provider choice,
  not the global weighted pool. The Home Assistant config repo keeps this
  OpenCode pin and receives HA MCP tools through the automated backend config.
- **Unpinned, weighted selection**: ordinary eligible issue/PR agent runs,
  including issue-refiner plan generation/refinement/follow-up, issue-worker,
  ci-fixer, review-addresser, and pr-reviewer, use the configured
  `aiProviders` pool unless an item label constrains them.

Pinning with `provider: "claude"` bypasses provider reselection entirely and fails
visibly on a Claude outage rather than silently routing to a provider that may
produce unusable output.
The planner itself defaults to the `opus` tier (no classification step) because issue descriptions are frequently too sparse to classify reliably, and a wrong downgrade — especially to the `haiku` tier — produces low-quality plans that propagate through every downstream implementation. When an issue carries the `Plan: Deep` label, `planModelForIssue()` in `issue-refiner.ts` overrides the model to the `fable` tier instead — the CLI's `fable` alias for Claude so the model ID tracks the latest release, `CODEX_FABLE_MODEL` (defaulting to `CODEX_DEFAULT_MODEL`) for Codex, `OPENCODE_FABLE_MODEL` (defaulting to `OPENCODE_BEST_MODEL`) for OpenCode — and `DEEP_PLANNING_CONTEXT` is injected into the prompt to direct extra capability toward deeper investigation rather than longer plans (the implementer model is unchanged, so the planner–implementer capability gap is wider than usual). Follow-up Q&A (`processFollowUp`) always uses the `sonnet` tier regardless of the label.
The planner prompt emphasizes that implementation will run on a smaller model and
instructs the planner to produce a detailed, specification-grade plan (exact file
paths, concrete edits, named invariants and gotchas) to keep the implementer on
track. Attribution footers (`*Models used: <model> (provider: <provider>)*`) are
appended to plan comments and PR descriptions to record which model/provider was
actually used.

### Skip-If-Busy Scheduling

Jobs that fire while a prior instance is still running are silently dropped —
no queue pile-up. This is distinct from the agent task queue; a job can be
"running" while waiting in the agent queue.

### Smart Scheduling

Low-priority background jobs (doc-maintainer, improvement-identifier,
issue-auditor, dependabot-alert-monitor, dependabot-run-monitor,
scanner-dispatcher, stale-branch-cleaner) use smart scheduling via
`smart-schedule.ts` rather than fixed intervals — all seven are wired through the
`smartScheduledJob()`/`smartScheduledBatchJob()` factories in `main.ts`. Each smart-scheduled job fires
hourly (configurable via `smartScheduling.tickIntervalMs`) and uses
staleness-based per-repo selection via `selectReposForTick()`:

1. **Due repos** (`targetStalenessMs`, default 24h): only repos not processed
   within the target staleness window are candidates for this tick.
2. **Busy gate** (`isClawsBusy`): skips the tick if `work_queue` has active or
   pending agent tasks (excluding `ignoreBusyKinds` — PR agents and smart-schedule
   jobs themselves are excluded so they don't block each other).
3. **SLO escape valve** (`sloStalenessMs`, default 48h): if Claws is busy but one
   or more repos have exceeded the SLO threshold, only those SLO-breached repos are
   processed regardless of busy state. A throttled Slack warning fires when the
   escape valve engages.
4. **Concurrency cap**: `withSmartJobSlot()` limits concurrent repo processing to
   `smartScheduling.maxConcurrentJobTasks` (default 4).

Jobs call `db.markRepoProcessedDaily()` after each successful repo run.
Skip statuses (disabled repo, no work needed, etc.) do not consume a daily
slot — only actual processing does. Most per-repo jobs (doc-maintainer,
improvement-identifier, issue-auditor, dependabot-alert-monitor,
dependabot-run-monitor, public-repo-scanner) get this via
`smartSchedule.withDailyRepoMarking(jobName, repo.fullName, fn)`, which wraps
the repo-processing call and marks it in a `finally` — so the ledger updates
even when `fn` throws, unless it threw a rate-limit failure, which leaves the
repo unmarked so it retries once the window resets — rather than each job
hand-rolling the call; the batch
job `scanner-dispatcher` marks every repo directly after its scanner loop
instead, since each scanner already isolates its own failures.
**This marking is load-bearing, not cosmetic**: a job that never marks a repo
processed leaves that repo's staleness age at `Infinity` forever, so it is
simultaneously "due" and "SLO-breached" on every tick, which trips the busy
escape valve on essentially every tick regardless of real staleness — the
originally-reported symptom (#1903) was `dependabot-alert-monitor` omitting
the call entirely.

**Manual trigger bypass**: `shouldRunSmartJob(name, now, manual)` gates the tick. All
eight smart-scheduled jobs are present as keys of `smartScheduling.jobs` by default;
if a job name is not a key (e.g. a user-edited `config.json` removed one), the gate
always passes regardless of `manual` or the `smartScheduling.enabled` flag. For jobs
that *are* keys, a `manual` trigger (`POST /trigger/:job` or the dashboard button)
also always passes — the global kill-switch (`smartScheduling.enabled = false`) only
blocks their unattended, non-manual ticks. In every case, staleness-based repo
selection in `selectReposForTick()` still applies (repos already processed within
`targetStalenessMs` are not reprocessed by a manual trigger).

The `main.ts` `smartScheduledJob()` factory wires the gate check into the scheduler's
tick and registers the job with `tickIntervalMs` as the interval.

**Staleness-first ordering**: `selectReposForTick()` in `smart-schedule.ts` sorts due
repos by age descending — the most stale repo is processed first. A stable tiebreak by
`fullName` ensures deterministic ordering when ages are equal. Repos never processed for
a given job have age = `Infinity` and always sort first, preventing starvation.
`db.getLastProcessedTimestampsForJob(jobName)` provides the `Map<repo, epoch-ms>` used
for age computation.

**Owner requirement — not yield-based backoff.** #663 originally proposed a
different design: track each fixed-interval job's "yield rate" (ticks that
find work vs. ticks that don't) and adaptively double the polling interval
during quiet periods, resetting on the next hit. That per-job yield-tracking
mechanism was never built (`scheduler.ts` has no concept of yield or
backoff). What shipped instead, for the nine low-priority jobs above, is the
staleness-based per-repo selection described here — a different mechanism
that happens to address the same underlying waste (polling repos with
nothing to do); `issue-dispatcher`/`pr-dispatcher` and the other
fixed-interval jobs still poll at a flat interval with no yield-based
adjustment.

### Worktree Isolation

Each task gets its own git worktree at
`~/.claws/worktrees/<owner>/<repo>/<job>/<branch>`. Both `createWorktree` and
`createWorktreeFromBranch` use `--no-track` to avoid `.git/config` lock
contention when concurrent worktree operations target the same repo. The job
namespace prevents path collisions. A namespace must be owned by exactly one
work-queue kind: `work_queue`'s partial unique index on `(kind, repo,
item_number)` guarantees at most one queued-or-running task per kind per item,
so single-kind ownership makes concurrent worktrees at one path impossible.
Conflict resolution therefore uses the `ci-fixer-conflict` namespace and is
reached only from `ci-fixer:conflict` tasks — the `ci-fixer` handler enqueues
that kind instead of calling `resolveConflicts` inline (#2158). Read-only jobs (`pr-reviewer`) use
`--detach` mode to avoid git's one-branch-per-worktree restriction, allowing
multiple jobs to read the same branch simultaneously. Write jobs (`ci-fixer`,
`review-addresser`) check out the branch on a namespace-scoped local branch
(`claws-wt/<job>/<remoteBranch>`), with a defensive fallback to detached mode
if the branch is already locked by another worktree. `removeWorktree`
auto-detects and deletes `claws-wt/` scoped branches after worktree removal.
The main clone lives at `~/.claws/repos/<owner>/<repo>`. Worktrees are always
cleaned up in a `finally` block after each task. The higher-level
`withNewWorktree<T>(repo, branchName, namespace, fn)` and
`withExistingWorktree<T>(repo, branchName, namespace, fn)` helpers in
`claude.ts` own the full create + try/finally cleanup lifecycle, eliminating
the footgun of forgetting cleanup. `withExistingWorktree` returns `null` if
the branch doesn't exist (absorbed `BranchDeletedError`). Most agents have
been refactored to use these helpers instead of manual `createWorktree` +
`finally removeWorktree` patterns.

`createWorktreeFromBranch` validates that the remote ref exists (via
`git rev-parse --verify`) before creating the worktree. If the branch has
been deleted (e.g. after a PR merge), it throws `BranchDeletedError`. The
convenience wrapper `createWorktreeFromBranchIfExists` catches this error
and returns `undefined`, allowing callers to skip work items with deleted
branches without noisy error reports. All PR-processing agents (pr-reviewer,
ci-fixer, review-addresser) use `createWorktreeFromBranchIfExists`.

Every interactive session is spawned via tmux as the service user, with the
repo worktree (or `$HOME`) as its cwd. Plain Claude sessions now ignore ambient
MCP configuration: Claws writes a per-session `--mcp-config` and passes
`--strict-mcp-config`, so only the Claws-owned MCP servers are available.
Claude sessions granted the `browser` capability deliberately switch to a
Playwright-only config (`includeClawsState: false`) rather than broadening that
session to include `claws-state`; the browser reads untrusted third-party pages
and the state-server token is process-local. Codex sessions likewise ignore the
ambient `~/.codex/config.toml` plugin/MCP set by running inside a private
per-session `CODEX_HOME`; this removes host-level plugin warnings, but does not
grant Codex any Claws MCP tools. Claude Code still resolves skills from both
the project's `.claude/skills/` **and** `~/.claude/skills/`, so a skill
installed once at the user level (via `deploy/install-skills.sh`, e.g.
`/postmortem`, `/ship`, `/title`, `/signoff`) is available in every Claws session in every managed repo, not
just the `claws` repo. A skill meant to run this way must not reference a
claws-repo-relative path — it executes inside a worktree of whichever repo the
session is working on.

### Mid-Session Capability Grants

A running session's process cannot take new env vars, so a capability granted
after spawn (#3072) — by the operator's Grant control or by approving an
agent's `claws_request_capability` request — is delivered as a file the agent
sources per Bash call (`. <path> && cmd`, since each call is a fresh shell),
except `github-auth`, which is delivered as a mounted credential file read
directly by `gh`/git (below). The file holds the vars of every effective
capability plus a `# claws-granted: <id>` marker line per capability, and the
grant is also written to `sessions.capabilities` so a resume injects it at
start.

- **`local-tmux`:** `granted.env` (0600) in the session's MCP dir, written
  before the call returns. It deliberately avoids `session-env/`, which
  recovery prunes while tmux sessions survive a restart.
- **`k8s-pod`:** the pod mounts only the Secret keys listed at launch, so every
  launch ships empty slot keys — `granted-env` and one
  `granted-kubeconfig-<capId>` per KUBECONFIG capability, plus an empty
  `github-token` when `github-auth` was not granted — and a grant PATCHes
  them. kubelet takes up to a minute or two to sync a mounted Secret, so the
  tool and UI tell the agent to wait for the marker line before sourcing
  `/etc/claws-workload/granted-env`; the server never blocks on it. A pod
  launched without the slots gets the grant on its next resume (`live:
  false`). `github-auth` is the one exception: see below.

  A `github-auth` grant mints the installation token straight into
  `github-token` instead, which the `gh` shim and git credential helper read
  directly at every call (#3131) — there is no `granted-env` var and no
  marker for it (`loadPath: null`, `marker: null`), so the tool and UI instead
  tell the agent that a `gh`/git call failing on a missing credential should
  be retried after a short wait rather than treated as a denial.
- `ssh:*` is grantable on both backends (#3322). On `k8s-pod` every host shares
  the Claws-owned keys in the `ssh-id_ed25519`/`ssh-id_rsa` Secret slots, which
  exist only when the pod launched with an `ssh:*` capability: the grant never
  PATCHes the Secret, and is live only when a key slot is mounted, otherwise
  `live: false` until a resume rebuilds the launch from the recorded list.
  Agent logins (`claude-auth`, `codex-auth`, `openrouter-auth`) and `browser`
  are never grantable mid-session; the terminal page's dropdown
  (`classifyLiveGrants`) shows them disabled with "fixed at launch — start a new
  session", and held capabilities disabled as "(granted)". `github-auth` is
  grantable, on `k8s-pod` (#3131).

Requests themselves are in memory (`capability-requests.ts`): a Claws restart
drops pending ones and the agent re-requests. How a held capability is
delivered is read from the runtime each time (`SessionBackend.grantDelivery`),
never remembered from the grant: for every capability but `github-auth`, the
granted file is reported only while it carries the capability's marker line (a
resume rewrites a pod's slots empty and injects the grant at start), and a pod
without the slot the grant needs reports `live: false`. `github-auth` instead
reports `live: true` as soon as the `github-token` slot is mounted, with
`loadPath: null` and `marker: null` throughout — there is no file to source.

An approval can land after `claws_request_capability` stopped waiting (#3106).
Each request records `lastPolledAt` on every agent request-route hit and
`grantSeenAt` when a route returns it granted. When a grant resolves a pending
request (approve, or the Grant control), the handler waits up to 8s for
`grantSeenAt` if the agent polled within the last 6s, and returns
`agentPickedUp` plus, if the agent did not collect it, `agentNotice` — a
one-line instruction to re-check with `timeout_seconds` 0 that never includes
the agent's reason. The approving page types that line through its own terminal
WebSocket and sends Enter separately, so it works on both backends with no pod
change; if the socket is closed it falls back to asking the operator. Denials,
unprompted Grant-control grants and `live: false` grants never notify. Text the
operator has half-typed at the prompt is submitted together with the notice.

### Graceful Shutdown

On SIGINT/SIGTERM, `main.ts` cancels all queued (not yet started) Claude tasks,
drains running jobs (5-minute timeout), terminates any in-flight Claude
processes (5-second grace period), closes the database, and exits. The
`shutdown.ts` module provides a shared `isShuttingDown()` flag that prevents
the agent queue from accepting new tasks during shutdown. Cancelled tasks
throw `ShutdownError` (a distinct error class), which the error reporter
suppresses — no Slack notifications or GitHub issues are created for shutdown
cancellations.

### Crash Recovery

At startup, any tasks still marked `running` in the database (from a previous
crash) have their worktrees cleaned up and are marked `failed` — except those
of a pod-backed work row, whose agent pod is still running them and is adopted.

### Releases & Rollback

Every non-docs push to `main` triggers `release.yml`, which tags and builds a
container image and publishes it to ghcr.io (#3096). Releasing dispatches
fleet-infra's `update-claws.yml`, which opens an auto-merged
`automation/bump-claws` PR bumping the image tag in
`clusters/my-cluster/claws/statefulset.yaml`; Flux reconciles and the
`claws-staging-0` StatefulSet rolls to the new image. Rollback means reverting
that image-bump PR in fleet-infra so Flux rolls the pod back to the previous
tag — there is no separate host-side updater or drain step. See
[OVERVIEW.md § Kubernetes Deployment](OVERVIEW.md#kubernetes-deployment) and
`docs/k8s-cutover.md` for the deployment's operating notes.

### Transient Retry & Rate Limit Circuit Breaker

Both the `gh` CLI wrapper (in `github.ts`) and the `git()` helper (in
`claude.ts`) retry up to 3 times with exponential backoff (1s, 2s, 4s) on
transient network errors. The `gh` wrapper matches HTTP status codes (400, 401,
500, 502, 503, 504), timeouts, connection resets, "Could not resolve to a",
"TLS handshake timeout", "Something went wrong", Go TCP dial "i/o timeout",
`"invalid character"` (Go `encoding/json` errors from `gh` when GitHub's Checks
API returns a transitional response during an in-progress check), EAGAIN /
"failed to create new OS thread" / "resource temporarily unavailable" (OS-thread
exhaustion when `TasksMax` cgroup pressure prevents Go binaries from spawning
threads), `"unexpected EOF"` and a bare `: EOF` (TCP connection dropped before or during the HTTP response; `gh`
wraps the latter as `failed to update <url>: EOF` — #2417). `getPRCheckStatus` and `getPRChecksSummary` additionally catch
`"invalid character"` in their own `catch` blocks and degrade gracefully to
`"none"` rather than crashing the `processPR` task — the pr-dispatcher re-runs
every 5 minutes, so missing one cycle is invisible to the operator.
The `git()` helper matches HTTP 5xx, ETIMEDOUT, ECONNRESET, ECONNREFUSED,
EAGAIN, TLS handshake timeout, DNS failures, "i/o timeout", "failed to create
new OS thread", and "resource temporarily unavailable" — plus, as a separate
alternative group appended for OpenSSH's own connect-failure wording
("Connection timed out", "Connection refused", "Network is unreachable",
"Connection closed by remote host", `kex_exchange_identification`,
`client_loop: send disconnect`), since a `git@github.com:` SSH remote reports
a connect timeout as `ssh: connect to host github.com port 22: Connection
timed out`, which shares no substring with the HTTPS/libcurl phrasing above it
and so previously retried zero times before failing permanently (#2471).
Permanent SSH failures ("Permission denied (publickey)", "Host key
verification failed", "Repository not found") deliberately still match
nothing. The `gitRaw()` helper does not retry — callers
manage their own error handling.

A GitHub-wide incident is a distinct failure class from a single flaky call:
`github-status.ts` polls githubstatus.com every 2 minutes and, while a
component Claws depends on is non-operational, `error-reporter.ts` downgrades
every `gh`/`git` CLI failure to a warning instead of filing/updating a
`[claws-error]` issue per repo per dispatcher tick — see
[Error Reporting & Investigation Pipeline](#error-reporting--investigation-pipeline)
and [GitHub-Wide Incident Detection](#github-wide-incident-detection) below.
Rate limit errors are handled separately: they trip a circuit breaker that
blocks all GitHub API calls, throwing `RateLimitError` immediately without
retry. The cooldown is derived from GitHub's real reset time where one is
available — the `x-ratelimit-reset` header on `listInstallationRepositories`'s
`fetch` path, or a `GET /rate_limit` probe (`fetchRateLimitResetMs` in
`github-app.ts`, free and deduped to one in-flight call per outage) for the
`gh` subprocess path, whose stderr carries no headers — falling back to a flat
60 seconds when no reset is available and clamping at 1 hour so a bad header
can't wedge the breaker open. A trip's deadline only ever moves later: a
shorter cooldown (e.g. the fallback) never shortens an already-set later one.
The `gh` path opens the breaker *synchronously* on the 60 s fallback the
moment the 403 lands — so concurrent and subsequent calls are blocked, and the
failing call rejects, without waiting on the probe — and the probe then extends
the deadline to the real reset time when it returns. A single Slack
notification is sent on the closed→open transition, and another when the first
API call succeeds after the cooldown expires — a second trip while the breaker
is already open just logs. The `gh` path's provisional trip is deliberately
*silent* (`setRateLimited(ms, { announce: false })`) so the one alert is sent
by the probe's trip and names the real resume time rather than a misleading
"1m". `listInstallationRepositories()` carries the same top-of-function guard as
`gh()`, so every caller of the installation-repositories endpoint — repo
discovery and the public-repo scanner alike — is covered by construction
rather than by each remembering to check. Jobs that iterate
over repos short-circuit their loops via `isRepoRateLimited(fullName)` — not
the bare `isRateLimited()` — to avoid cascading failures during a rate-limit
window while still dispatching Forgejo repos, since the breaker is GitHub-only
and, with the deadline now GitHub's real reset time, can stay open for up to
the 1h clamp (#3221); `pr-dispatcher`, `issue-dispatcher` and the
`auto-merger` job additionally log once at the top of each cycle when they
skip it entirely because the breaker is open, so a manual dashboard trigger
isn't indistinguishable from "nothing to do". Repo discovery
(`fetchRepos()` in `github.ts`) skips the GitHub owner loop outright while the
breaker is open rather than re-probing an exhausted budget every cycle — the
degraded-cache revival path (`listRepos()`, #2908) serves the previously
discovered repos for that owner instead, and Forgejo enumeration (which runs
first and never consults the breaker) is unaffected.
`createIssue()` and `createPR()` are not idempotent server-side operations,
so retrying a call whose server-side write succeeded but whose response was
lost to a transient error would otherwise surface an opaque "already exists"
failure and, for `createIssue`, potentially file a duplicate. Both catch that
specific error string, parse the issue/PR number out of it, and return that
number instead of throwing — treating a retry-induced duplicate as success
rather than a spurious `[claws-error]` (#197).
Because of this, independent read-only per-item fetches on a hot path (e.g.
`findUnreactedHumanComments` in `issue-refiner.ts`, called every dispatcher
cycle) are gathered with a plain `Promise.all` rather than a bounded-concurrency
wrapper — the owner explicitly rejected adding a concurrency cap here (#1621):
a proposal to defensively cap fan-out at 5 in flight was reverted once it was
confirmed the `gh` wrapper's own rate-limit circuit breaker and retry-with-
backoff already cover this case, making a second throttling layer unnecessary
complexity. Prefer this reasoning before reaching for `mapWithConcurrency` on a
new hot-path loop of independent GitHub reads — it's still the right tool for
large batch fan-outs across many repos, just not for this class of call.

### WhatsApp Pairing Notifications

The WhatsApp module sends Slack notifications on pairing state transitions,
following the same "notify once per state change" pattern as the rate limit
circuit breaker. A `lastNotifiedState` variable deduplicates notifications:
a "pairing required" alert is sent once when the session is lost (logout,
stale session, repeated connection failures), and a "connected" notification
is sent only if a prior pairing-required alert was active. User-initiated
actions (unpair, stop pairing) do not trigger notifications.

Auth state is cleared only on status 401 (`loggedOut`) or 500 (`badSession`) —
the only statuses that actually invalidate credentials. Status 515
(`restartRequired`) fires after post-pairing key exchange and is transient —
the handler reconnects after 1 second without incrementing `consecutiveFailures`.
Every other disconnect (405 stale WA Web version, 440 `connectionReplaced`,
408, 428, unknown) retries indefinitely with backoff capped at 5 minutes and a
one-shot Slack alert after 5 consecutive failures, instead of destroying the
pairing (#2274) — a 440 no longer clears auth state, since the underlying
session is often still valid.

`startPairing()` explicitly resets `lastNotifiedState = "pairing-required"`
after `stop()` (which resets it to `null`) so the `"connected"` Slack
notification fires correctly after the new session establishes.

WhatsApp connection events are persisted to the `whatsapp_events` SQLite table
and accessible at `GET /whatsapp/events` (JSON) and displayed on the WhatsApp
dashboard page as a "Recent Events" log.

### Error Reporting & Investigation Pipeline

Errors flow through two stages:

1. **Error reporter** (`error-reporter.ts`) — Uses a 30-minute cooldown per
   fingerprint. Recurrences edit the body of the existing `[claws-error]` issue
   (via `ensureAlertIssue()`) rather than opening new ones or adding comments.
   `ShutdownError`, `RateLimitError`, `TransientGitHubError`, `PushConflictError`,
   `AllProvidersRateLimitedError`, and select `AgentCliError` patterns
   (usage-limit, transient API 5xx) are filtered before any reporting.
   `USAGE_LIMIT_RE` (`src/claude.ts`) matches the Claude CLI's usage-exhausted
   message — `You've hit your weekly limit · resets 2am (Europe/London)`, `You've
   hit your limit · resets 12pm`, `You're out of extra usage · resets 5pm` — by
   not hardcoding the qualifier between "your"/"re out of" and "limit"/"usage",
   since it varies (`weekly`, `5-hour`, none at all); an earlier literal match on
   one wording let every other wording fall through to a full Slack alert +
   `[claws-error]` issue per failing task, one per job-kind fingerprint since the
   30-minute cooldown is per fingerprint (#2590). The same regex also feeds the
   provider-reselection path in `runClaudeInner`, short-circuiting straight to a
   rate-limit classification without an Ollama round-trip. `AllProvidersRateLimitedError`
   (thrown by `runClaudeInner` when every eligible provider is
   already inside its cooldown, replacing a bare `Error`) is downgraded to a
   warning for the same reason — expected and transient, not a bug to alert on.
   A `gh`/`git` subprocess failure is also
   downgraded to a warning — instead of filing/updating a `[claws-error]`
   issue — while `github-status.ts` reports GitHub itself is mid-incident
   (`isGitHubDegraded()`); a per-component check (not the overall status
   indicator) keeps a Copilot/Codespaces-only incident from suppressing
   genuine Claws errors, and a 10-minute recovery grace period covers 403s
   that linger briefly after components flip back to operational (#2486).
   The dashboard's Integrations panel and a one-shot Slack notice on each
   incident transition carry the signal instead. **Cross-repo / cross-process
   dedup**: `ensureAlertIssue` and `upsertAlertIssue` (`src/occurrence-tracking.ts`)
   serialize concurrent calls for the same repo+title behind an in-process
   per-title lock, and remember an issue they just created for 2 minutes so a
   stale cached `listOpenIssues` list in flight elsewhere still resolves to an
   update rather than a second `createIssue` (issue #3037's same-second
   `[disallowed-actor]` race across two repos). `ensureAlertIssue` also takes
   an optional `coveredBy(issue)` predicate, checked over the same cached
   open-issue list only when no title/legacy-title/recently-created match
   exists — on a match the alert is skipped as `"covered"` instead of filed,
   for cases where another process's issue already carries the same signal;
   no caller currently passes it. Source-level filtering also applies: the
   WhatsApp module's Baileys logger suppresses transient errors (keep-alive
   timeouts, stream errors, bad-request) at warn level before they reach the
   reporter. When Baileys uses structured logging (object + message string),
   `baileysLogger.error` also checks `obj.err` against `TRANSIENT_MESSAGES` —
   this catches cases where the human-readable `msg` differs from the underlying
   error value (e.g. `"unexpected error in 'init queries'"` with `err: "bad-request"`).
2. **Triage** (`triage-claws-errors.ts`) — Discovers `[claws-error]` issues
   by title pattern (no label required), runs two-phase deduplication (by
   fingerprint before investigation, then by root cause after), and posts an
   investigation report. Reads `docs/OVERVIEW.md` for context and identifies
   related issues that share the same root cause. Every investigation prompt
   requires Claude to end its output with a `RELATED_ISSUES: <numbers|none>`
   sentinel. `isReportTruncated(output)` checks for this sentinel; if absent,
   the investigation is retried once with a fresh `runClaude` call. If the
   retry output is also truncated, the task is recorded as complete with zero
   commits (no comment is posted) so that no `REPORT_HEADER` is written and the
   next scheduled triage run picks the issue up again — avoiding a permanently
   truncated report being posted.

### GitHub-Wide Incident Detection

`github-status.ts` polls `https://www.githubstatus.com/api/v2/summary.json`
every 2 minutes (the `github-status` job) to distinguish "GitHub itself is
having an incident" from an ordinary per-repo transient failure (#2486).
`degraded` is computed per-component — `components.some(c =>
COMPONENTS_WE_DEPEND_ON.has(c.name) && c.status !== "operational")` over
`{Git Operations, API Requests, Webhooks, Issues, Pull Requests, Actions}` —
deliberately not from `status.indicator`, so a Copilot/Codespaces-only
incident (which still sets `indicator: "minor"`) does not suppress genuine
Claws error reporting. `isGitHubDegraded()` also stays true for a 10-minute
grace period after components flip back to `operational`, because 403
"Resource not accessible by integration" responses from a mid-incident App
token are observed to linger briefly past the status page's own recovery;
conversely a stale snapshot (no successful poll in 15 minutes) can no longer
gate suppression at all, so a hung poller fails open to normal reporting
rather than silently muting alerts forever. A poll failure itself is
`log.warn`-only and never throws — throwing would route through the
scheduler's own `reportError()` and file the exact `[claws-error]` issue this
mechanism exists to prevent.

`error-reporter.ts` consumes `isGitHubDegraded()` to downgrade any `gh`/`git`
subprocess failure (matched via `isGitHubCliError()` on the fixed `gh <args>
failed:` / `git <args> failed in ` message prefixes) to a warning while an
incident is live, instead of filing or bumping a `[claws-error]` issue per
repo per dispatcher tick. The result is also surfaced directly: the
dashboard's Integrations panel links to githubstatus.com and shows the active
incident name plus a relative "last checked" time, and each transition into
or out of `degraded` posts exactly one Slack notice (not one per tick).

### CI-Fixer Circuit Breaker

The ci-fixer includes a circuit breaker to prevent infinite automated fix
attempts on PRs where CI continues to fail despite multiple attempts.
Configuration via `ciFixerCircuitBreaker` in `config.json`:

| Config key | Default | Description |
|---|---|---|
| `maxAttempts` | `5` | Maximum CI fix attempts per PR within the window |
| `windowMs` | `86400000` (24h) | Time window for counting attempts |
| `maxConsecutiveFailures` | `3` | Maximum consecutive failures before tripping |
| `maxCommitGrants` | `3` | Lifetime new-commit fix grants per PR (see below) |

Attempts whose `outcome.failureCategory` is one of `rate-limit`, `usage-limit`,
`transient-api`, `auth-expired` or `shutdown` never reached the agent — they say
nothing about the diff. `countCIFixerAttempts` still reports them in raw `total`,
but the ci-fixer subtracts them from the `maxAttempts` budget, the conflict
budget's `unproductive` count, and the breaker's consecutive-failure count. A
conflict-resolution attempt that fails this way puts the PR in a 15-minute
backoff instead of being re-dispatched on the next 90 s dispatcher sweep (#2977).

The breaker only trips while the PR still has **dispatchable work** — a failing
check, or a `CONFLICTING` mergeable state the conflict resolver keeps failing to
clear. Exceeding the attempt budget on a green, mergeable PR logs and does
nothing: there is no further work to stop, and re-applying `Claws Problematic`
there just fights the diagnoser's stale-label clearing, which strips it again on
the next pass (#2390: ~18 add/remove cycles on one PR). The diagnoser enforces
the mirror-image rule — see `hasBlockingConflict()` below — so the two
definitions of "dispatchable work" stay in sync. If they diverge, one side loops
silently forever: gate only on the failing check and a permanently-conflicting PR
gets an endless stream of resolver runs with no escalation; clear the label on
green CI alone and a conflict-triggered trip never sticks.

When thresholds are exceeded, the PR is marked as problematic:
- Further automatic CI fix attempts are skipped
- A comment is posted on the PR explaining the situation
- Manual unmarking: remove the `Claws Problematic` label, or call `POST /queue/unmark-problematic` (the `/queue` page's "Problematic PRs" section that had a button for it was removed)

#### New-commit grants

A problematic PR is not frozen forever. A commit pushed to it *after* the
breaker tripped is new information — usually the manual intervention the
problematic comment asks for — so `identifyPRWork` grants a fresh attempt
budget for it (`maybeGrantNewCommitAttempt` in `src/agents/ci-fixer.ts`).

State lives in the `ci_fixer_breaker` table, keyed `(repo, item_number)`:

- `tripped_sha` — the head SHA when the breaker tripped
  (`recordCIFixerBreakerTrip`, called from `triggerCircuitBreaker`).
- `last_claws_sha` — the head SHA of the most recent push Claws made to the
  branch (`recordCIFixerPush`). **The critical guard**: the ci-fixer pushes
  commits itself, so "the head moved" alone is not evidence of manual
  intervention. Every ci-fixer push goes through the `pushPRBranch` helper, and
  the problematic-PR diagnoser and review-addresser record their own pushes too
  (pr-dispatcher does not skip problematic PRs for review rounds, so the
  addresser can legitimately push to one). Missing a push site would let a
  Claws-authored commit reset its own budget — an unbounded retry loop.
- `budget_floor_at` — a timestamp floor passed to `countCIFixerAttempts` as its
  optional fourth argument, so attempts made before a grant stop counting
  toward `maxAttempts`. The budget *resets* per new commit rather than
  disappearing.
- `grants` — lifetime count of automatic grants, capped at `maxCommitGrants`.

A grant fires only when the current head differs from both `tripped_sha` and
`last_claws_sha`, and checks for that head are no longer `pending`. A status of
`none` is only believed once the head commit clears the settle window
(`haveChecksSettled` in `src/github.ts`, shared with the auto-merger) — CI takes
a minute or two to register runs against a fresh SHA, and reading that gap as
"green" would clear the label before anything ran (#2354). If the new
head is green the label is cleared and `grants` resets to 0; if it is still
failing the label is cleared, one grant is spent, and the PR re-enters the
normal fix flow bounded by the usual thresholds.

A PR with no `tripped_sha` (label applied by a human, or by a build predating
this table) stays frozen — fail-closed. Both the manual unmark endpoint and the
diagnoser's label removals call `resetCIFixerBreakerGrants`, which clears the
trip, zeroes `grants` and advances the budget floor; without that floor the
pre-existing attempts still inside the 24h window re-trip the breaker on the
very next sweep.

Every one of those state writes happens **after** `removeLabel` confirms the
label is gone, never before. `removeLabel` returns a boolean: `gh issue edit
--remove-label` errors both when the label was never applied (benign) and on a
transient API failure (not benign), so on error it re-reads the live labels to
tell the two apart. Committing the state write against a label GitHub still
shows would leave the breaker looking untripped while the PR stays labelled —
and since `maybeGrantNewCommitAttempt` only runs for PRs with a `tripped_sha`,
that combination freezes the PR permanently with no further grant possible.
`removeLabel` now reads the live labels *before* attempting the edit as well,
so `true` can also mean "was already absent" — callers persisting "this label
is gone" state remain correct either way (#2957).

Attempt counting is database-backed via `countCIFixerAttempts()` in `db.ts`,
which queries the `tasks` table for CI fixer attempts per PR within the
configurable window and returns `{ total, failed, successful, transientApiFailed }`
— transient API failures (4xx/5xx infrastructure errors) are counted separately
so they don't unfairly trip the circuit breaker. The `Claws Problematic` label
is applied to flagged PRs.

After the label is applied, `pr-dispatcher` enqueues a one-shot
**problematic-PR diagnosis pass** (`ci-fixer:problematic` kind →
`src/agents/problematic-pr-diagnoser.ts`). The diagnoser first checks whether
CI has already recovered before running any rounds: if `getFailedRunLog()`
returns empty, it calls `getFailingCheck()` and — if no check is failing —
calls `getPRCheckStatus()`; when the status is `"passing"` or `"none"`, it
immediately resolves as `success` and removes the label (CI recovered between
the label being applied and the diagnosis pass running — e.g. a flaky check
passed on retry, a transient infra failure cleared, or a manual fix landed).
The dedup guard that prevents re-running the diagnoser once a final report comment
exists (`DIAGNOSIS_COMMENT_MARKER`) now also clears the `Claws Problematic` label
before short-circuiting, via `clearStaleProblematicLabelIfGreen()` — this handles
the case where CI recovered on its own (flaky check passed on retry, transient infra
cleared, manual fix landed) after the diagnosis report was posted. Without this,
a PR that goes green post-diagnosis keeps the stale label forever because the marker
blocks every future diagnosis pass.

Both recovery checks additionally consult `hasBlockingConflict()`
(`getPRMergeableState() === "CONFLICTING"`, failing closed to `true` on an API
error so a transient failure never strips a label). Green CI alone is not
recovery: the breaker also trips on unresolvable merge conflicts, so clearing the
label on a green-but-conflicting PR would drop the label the breaker just applied
and hand the PR straight back to the conflict resolver. A round-1 pass that finds
green CI on a conflicting PR resolves as `no-fix-possible` instead — the label
stays and the report asks for a manual rebase.

Only when CI is genuinely still failing does the diagnoser run up to
`MAX_ROUNDS` (3) deeper-diagnosis rounds: each round invokes Claude with the
full failure-log + recent-error history and an explicit instruction to take a
more thorough approach (consider reverting earlier ci-fixer commits, merging
the base branch, etc.). When Claude produces commits the diagnoser pushes the
branch and polls CI for up to 30 min per round (`getPRHeadSHA` +
`getFailingCheck` + `getPRCheckStatus`). On success it removes the
`Claws Problematic` label so the PR re-enters the normal flow; on failure or
exhaustion it posts a single final report comment (marker:
`problematic-pr-diagnosis-report`) that the dedup guard uses to prevent
re-entry. Each round records its own task with `job_name = 'ci-fixer:problematic'`
so the round-by-round logs are visible at `/logs/issue?repo=...&number=...`.
Fork PRs and `[ci-unrelated]` fix PRs are skipped — the diagnoser can't push to
forks, and `[ci-unrelated]` PRs are already a downstream remediation path.

### CI-Fixer Two-Phase Design

The ci-fixer uses a two-phase identify/process pattern (matching the pattern
used by improvement-identifier and issue-refiner):

1. **Identify**: Scans all PRs, checks merge state, CI status, and classifies
   failures — collects typed `WorkItem` entries (a discriminated union with
   variants: `conflict`, `rerun`, `unrelated`, `fix`)
2. **Process**: Groups unrelated failures by repo (structural dedup — one
   consolidated issue per repo), then processes remaining items concurrently

This eliminates race conditions when multiple PRs in the same repo have
unrelated CI failures — without the grouping, concurrent `findIssueByExactTitle` +
`createIssue` calls would produce duplicate issues.

Reruns are emitted both for cancelled/startup-failure workflows and when
failure log fetching returns empty (the `getFailedRunLog` two-tier fallback —
CLI then REST API — both returned no output). Each no-log cycle is handled by
`handleMissingFailLog()`, which records a `ci-fixer` task failure with
`failureCategory: "logs-unavailable"`. This counts toward the circuit
breaker's `nonTransientFailed` counter (only `transient-api` rows are
excluded), so a PR whose logs are permanently unfetchable trips the breaker
after `maxConsecutiveFailures` cycles rather than looping indefinitely.
Benign "already running" errors (a harmless race condition where the workflow
restarted between detection and rerun) are caught and logged at info level
rather than reported as errors. Non-rerunnable workflows (`"cannot be rerun"`
from GitHub — e.g. runs older than 30 days) are logged at warn level and also
not reported as errors; these are expected terminal conditions, not Claws bugs.
`reportRunNotRerunnable()` (#2218) records the run ID in `deadRerunIds` (so
neither classification path — the cancelled-run branch nor the
logs-unavailable fallback — retries the same dead run every sweep), labels
the PR `Manual Action`, and writes a one-time notice into the PR body's
manual-action section asking a human to push a commit or close/reopen the PR
to get a fresh CI run; it deliberately does **not** file a standalone alert
issue — the label is already the durable, actionable signal auto-merger
honours, and a matching issue only duplicated it with no new information
(#2218, filed 7 times against one PR before the fix).

That label was, until #2462, permanently sticky: nothing ever removed it once
the dead run was superseded by a fresh one, so a PR that went green (a human
push, a Claws-authored fix commit, or a reopen) stayed stuck behind
`Manual Action` forever and auto-merger skipped it indefinitely
(`bstjohn-blog#581` — green at 02:22, still unmerged hours later). The mirror
function `clearNotRerunnableIfResolved()`, called once per PR per
`pr-dispatcher` sweep right alongside `reportRunNotRerunnable()`, clears it:
if the PR carries `Manual Action` **and** `gh.getPRCheckStatus()` reports
`"passing"` **and** the PR body still contains the
`claws:not-rerunnable-run` marker, it strips just that marked section from
the body via `stripNotRerunnableSection()`. `"none"` and `"pending"` check
status deliberately do not clear anything: nothing has re-tested the branch
yet, and clearing on those would unblock a merge on unverified code.

Green CI only retires *this function's own* reason for the label — the same
label carries other agents' reasons too, and only one of them is visible in
the body. If another manual-action section survives the strip (e.g.
issue-worker's own `MANUAL-ACTION:` note), or `hasEscalatedReview()` reports a
pr-reviewer escalation still outstanding (a blocking finding the implementer
refuted, or a review loop that never converged — labelled but recorded only
as a review comment, invisible to a body scan), the label stays; only the
stale not-rerunnable note is stripped. Only when neither other reason applies
does the function also remove `Manual Action` itself. Label removal happens
before the body rewrite (mirroring `maybeGrantNewCommitAttempt`'s ordering,
#2391) so a failed second call never leaves the PR blocked with nothing left
for the next sweep to re-detect.

`clearNotRerunnableIfResolved`'s "another manual-action section remains" check
(via `extractManualActionSection`) deliberately only looks at the pre-merge
`## ⚠️ Manual action required before merge` heading — a
`## 📋 Manual action required after merge` section never blocks label
clearing, since it was never a reason the label was applied in the first
place (#2620). Note also that the post-merge announcement (a PR comment plus
Slack ping, sent from `announcePostMergeAction` in `auto-merger.ts`) only
fires when `tryMerge` performs the merge; a PR merged by a human directly in
the GitHub UI does not run through it, so no comment or ping fires — the note
is still readable in the merged PR body, just not surfaced separately.
`announcePostMergeAction` also skips the comment and Slack ping when the note
is verification-only per `isVerificationOnlyAction()`, including for PR
bodies written before that filter existed (#2644).

**Missing `Actions: write` permission is not a dead run (#2514).** GitHub's
`403 Resource not accessible by integration` — the App installation lacks
`Actions: write` — used to be matched by the same `"cannot be rerun"`-adjacent
regex as a genuine per-run refusal, so a fleet-wide permission misconfiguration
mislabelled every affected PR `Manual Action` with a factually wrong
explanation and poisoned `deadRerunIds` so retries never resumed even after
the permission was granted. `isActionsPermissionDenied(err)` (all four rerun
call sites in `ci-fixer.ts`) now recognises this case separately:
`reportActionsPermissionDenied(fullName, runId)` files a single one-time
`[claws-config]` alert issue on `SELF_REPO` (an in-flight promise, stored
synchronously before the `await`, so two worker fibers hitting the org-wide
403 in the same sweep share one `ensureAlertIssue` call instead of racing to
file duplicates) and returns — the run is never added to `deadRerunIds`, the
PR is never labelled, and the next sweep retries automatically once an
operator grants the permission in the App's settings. `identifyPRWork`'s
GitHub-incident fast-path also now covers `isPreRepoStepFailure` (a job that
fails only in GitHub's own setup/checkout step, e.g. a codeload 429
downloading `actions/checkout`) in addition to `isInfrastructureOutage`
(zero recorded steps) — both are evidence of the incident, not a defect in
the diff, so neither spends fix-attempt budget while `isGitHubDegraded()` is
true.

**`[ci-unrelated]` fix PRs**: When ci-fixer processes a PR whose title
contains `[ci-unrelated]` (i.e., a PR created by issue-worker to fix a
`[ci-unrelated]` issue), it skips the classification step entirely and treats
all CI failures as related. Without this guard, the classifier would see the
pre-existing failures, classify them as "unrelated to the PR's changes", and
the PR would stall indefinitely in a loop of filing redundant issues and
reverting fix attempts. Errors on these PRs are posted as comments directly
on the PR rather than creating `[claws-error]` issues.

**No stacked PRs**: Every PR Claws opens targets the repository's default
branch, and no agent may change an existing PR's base — `NO_STACKED_PRS_POLICY`
(`src/agents/agent-context.ts`) states this in the pr-reviewer, review-addresser,
ci-fixer and issue-worker prompts, and `sweepStackedPRs()` in `pr-dispatcher`
flags anything that slips through with `Manual Action`. The invariant came from
#2720: a `[ci-unrelated]` issue's fix touched files that existed only on an open
PR's branch, the implementer could only open a PR against `main` (so it carried
that PR's whole diff), and the reviewer's suggested remedy — retarget the base —
produced a stacked PR instead of fixing the cause. The escape hatch is
`CLAWS_TARGET_PR: #N`, a line the planner may put at the end of a single-phase
plan. `issue-worker` then checks that PR's head branch out with
`claude.withExistingWorktree`, commits the plan's changes onto it, pushes, and
appends `Closes #<issue>` to that PR's body rather than opening a PR at all. It
is validated defensively — the PR must be open, non-fork, on a `claws/` head
branch, and based on the default branch — and every rejection falls back to a
normal PR against the default branch, which is always an acceptable outcome. In
target mode commit detection compares the HEAD SHA before and after the run
rather than using `hasNewCommits`, since the branch is already ahead of the
default branch, and `Automerge` is deliberately not propagated to the target PR.

### No-Commit Feedback

When the implementer (issue-worker) runs but produces zero commits, it first
calls `diagnoseNoCommits(wtPath, baseBranch)` in `claude.ts` — a cheap Claude
invocation that inspects `git status`, `git log`, and `git diff --stat` to
produce a 1–3 sentence diagnosis (e.g. "implementation already appears complete",
"files were edited but not committed"). The diagnosis is injected as a
`**Diagnosis:**` block into the `## No changes produced` comment. If the
diagnostic call fails, the comment is posted without it (`.catch(() => null)`
guard). The comment is deduplicated per phase via a `no-commit:${currentPhase}`
plain-text marker — if a prior comment for the same phase already exists, no
new comment is posted. The `Refined` label is removed before the comment is
posted, preventing re-entry until the user explicitly retries.

### Multi-Phase Plan Validation

After a multi-phase plan's PR is merged, the issue-worker runs
`validateAndUpdatePlan()` which compares the completed phase's plan text
against the actual PR diff using Claude. If significant deviations are
found, the plan comment is updated in-place so subsequent phases have an
accurate picture of reality. The update is tracked via a
`plan-updated-after-phase:N` plain-text marker (deduplication —
each phase only triggers one update). Validation failures are caught and
logged but never block phase advancement.

**Phase overflow protection**: if the derived phase (see Multi-PR Phase
Coverage below) exceeds `totalPhases` (can occur after plan edits reduce
phase count), `processIssue()` returns early and removes the `Refined`
label — allowing the planner to re-refine with an updated phase count.

**Owner requirement — addressed by #2594.** #831 (a multi-PR issue that
stopped progressing) asked for more than drift detection: *"We shouldn't
rely on counting PRs. The plan should be reassessed in light of all PRs that
have been merged and any outstanding work should be identified. Counting PRs
is too simplistic."* Before #2594, `currentPhase` selection was exactly
`mergedPRs.length + 1` over merged PRs on `claws/issue-<N>-` branches — a
count, and one blind to PRs opened by anyone else. `phase-coverage.ts` (below)
replaced that with a covered-phase set assembled from every PR that
cross-references the issue plus explicit claim comments, which is the
holistic reassessment #831 asked for. Treat this as resolved unless a similar
stall recurs from a gap the marker/claim mechanism itself doesn't cover.

All three
build helpers (`buildPrompt()`, `buildPRTitle()`, `buildPRBody()`) include
defensive bounds checks on `plan.phases[currentPhase - 1]` as a second guard.

### Multi-PR Phase Coverage

`phase-coverage.ts` (#2594) is the module `validateAndUpdatePlan`/`processIssue`
consult for "which phase am I on and is it safe to start it." It replaced a
purely positional count (`mergedPRs.length + 1` over `claws/issue-<N>-`-branch
merged PRs) after a production-infra#1313 incident: an interactive session explicitly took
over a multi-PR issue mid-sequence, merging/opening PRs itself, and the
pipeline — still counting only its own branch prefix — duplicated two of the
four steps because it couldn't see work done out-of-band.

`computePhaseCoverage()` builds a `PhaseCoverage` from three inputs, unioned:

1. **Legacy positional fallback** — merged PRs on `claws/issue-<N>-` branches,
   mapped to phases 1..N by merge order. Kept so behavior is unchanged when no
   marker or claim is present anywhere.
2. **Phase markers on cross-referencing PRs** — any PR (any author, any
   branch) that references the issue (`#N` in the title, or
   `closes`/`fixes`/`resolves`/`part of`/`for #N` in the body) *and* carries a
   `(N/M)` title suffix or `## PR N of M:` body header, where `M` matches the
   plan's current `totalPhases` (a re-plan that changes the phase count
   invalidates old markers). Closed-unmerged PRs are excluded — counting a
   rejected duplicate would mark its phase covered forever. An explicit marker
   beats the legacy positional guess, and among markers a merged PR beats an
   open one, but a legacy (already-merged) entry is never displaced by a
   merely-open marker PR.
3. **`claws-phase-done: <numbers>` claim comments** — for a step that produces
   no PR at all (a manual `tofu apply`, a workflow dispatch). Only comments
   from `gh.isAllowedActor` logins count, and a `1,3-4`-style range is clamped
   to `1..totalPhases` *before* iterating so a typo like `1-99999999999` can't
   hang the loop. The claim must also be *asserted*: first text on its own line,
   not inside a code fence or blockquote, and not in a comment carrying the
   "Automated by Claws" footer (#3154). All marker matching goes through
   `marker-text.ts`.

The trust asymmetry is deliberate: a PR marker is evidence that survives
inspection (linked from the issue timeline, and an untrusted author's PR still
can't merge), while a claim asserts work happened somewhere unreviewable, so
it needs an already-trusted actor.

Two derived sets matter beyond the raw `covered` set:

- **`done`** (merged PR or claim, not merely an open PR) gates anything
  irreversible once the current PR merges — in particular, whether the phase
  being implemented is the last one and may carry `Closes #<issue>` in its PR
  body. A phase covered only by a still-open PR must not trigger `Closes`,
  since that PR could still be closed unmerged or rewritten.
- **`readyPhases`** decides what may start. A phase covered only by an open
  PR is "covered" but not done, and worktrees always branch off the default
  branch, so starting a phase that depends on it would build on a base
  missing its prerequisite.

**Readiness** lets a plan declare which PRs depend on which. `finishCoverage()`, shared by `computePhaseCoverage()` and
the stored-list path in `planned-prs.ts`, derives each phase's effective
dependencies (the stored `depends_on`, else the `### PR N: … (after PR 1)` /
`(parallel)` header suffix, else the previous phase) and splits the phases
into `readyPhases` (uncovered, with every phase in the transitive closure of
its dependencies in `done`), `blockedPhases` (uncovered, not ready) and
`openPhases` (covered by an open PR alone, at any position). A dependency may
only name a lower phase, so there are no cycles, and with no declared
dependencies `readyPhases` is `[nextPhase]` exactly when every phase below
`nextPhase` is done. `/api/issue-phases` reports all three. The dispatcher's
multi-PR continuation and the implementer start `readyPhases[0]`; the
issue-auditor's `classifyIssue` treats a non-empty `openPhases` as "a PR is in
flight"; and the auto-merger's post-merge hook closes a multi-PR issue once
every phase is in `done`.

A merged PR whose `(N/M)` marker names *more* phases than the plan currently
has is recorded in `markerMismatches`: a re-plan dropped `### PR N:` headers
that already-shipped PRs were numbered against. An open issue whose every plan
phase is covered gets a one-time `CLAWS_ALL_PHASES_COVERED` notice (naming any
mismatch) plus `Ready` instead of silently losing `Refined`, and the dispatcher
checks coverage before auto-applying `Refined` so `Claws Auto-Refine`/`[ci-unrelated]`
issues can't ping-pong the label against the implementer's all-covered guard
(#2821).

`loadPhaseCoverage()` is the entry point (`src/agents/issue-worker.ts`, used
both when deriving the current phase and when validating a just-merged one);
it fetches cross-referencing PRs via `gh.listPRsCrossReferencingIssue()`
(the issue's GitHub timeline API, `--paginate`d — a single page missed a
real duplicate during the #2594 investigation) and never throws: any failure
degrades to the legacy-only computation rather than blocking the dispatcher.

Interactive sessions default to monitoring and steering the pipeline, but are
taught the identical PR-title/body marker and `claws-phase-done:` conventions
via `SESSION_WORKFLOW_PROMPT` (injected into every session) and
`CLAWS_AUTOMATION_DOC` (synced into every managed repo's
`docs/claws-automation.md`) for the cases where they explicitly take a step by
hand, and can check current coverage beforehand via the read-only
`claws_issue_phases` MCP tool
(`GET /api/issue-phases`) — see [MCP Server Context](#mcp-server-context).

### CI & Codebase Infrastructure Monitoring

The `runner-monitor` job runs independently. The remaining eleven scanners
(ubuntu-latest, concurrency, migration, cache-on-self-hosted, issue-comment-spam, runner-os, claude-config, dependabot-config, design-guidelines, dynamic-workflow-runner, host-policy) run sequentially via `scanner-dispatcher`:

- **runner-monitor**: SSHes to configured self-hosted GitHub Actions runner
  hosts on a 10-minute interval. Checks service health (restarts dead `svc.sh`
  services), detects zombie/stale Runner.Worker processes (kills orphaned
  processes older than 6 hours only if the runner service is down), and
  monitors disk usage with tiered cleanup: Tier 1 (>85%) runs basic cleanup
  (temp files, `docker system prune -f`, `docker image prune -af --filter 'until=24h'`
  to remove tagged CI images older than 24 hours, journal vacuum); Tier 2 (>90%) adds
  aggressive cleanup (all unused Docker images + volumes, tool cache). The
  `until=24h` filter keeps in-use images (active CI runs) safe while reclaiming
  tagged-but-old build cache images that `docker system prune` misses. After
  cleanup, if disk is still >90%, `getDiskBreakdown()` fetches a disk usage
  breakdown and either comments on an existing open `[runner-monitor] Persistent
  high disk` issue or creates a new one (label: `runner-maintenance`).
  `getDiskBreakdown()` uses sequential per-probe SSH calls (60s timeout each
  via the optional `timeoutMs` parameter of `sshExec`) instead of a single
  bundled command — probes include `df -h /`, `du -sh` per directory, top
  docker images by size, and `docker system df`; each probe is wrapped in its
  own `try/catch` so a slow probe does not abort the rest. Actions taken are
  reported via Slack. Runner hosts are configured with baked-in defaults
  (one Hetzner server, overridable via `runners` in `config.json`).
  Supports two runner flavours, selected by the presence of `serviceUnit`
  in the config entry: self-installed `svc.sh` runners (`actionsDir`) and
  NixOS `services.github-runners` systemd units (`serviceUnit` + `workDir` +
  `toolDir`) — see `docs/jobs/runner-monitor.md` for the full command/path
  mapping.
  **Security**: `actionsDir`/`workDir`/`toolDir` are validated against a
  safe-path regex (`/^\/[a-zA-Z0-9._/-]+$/`) and `serviceUnit` against
  `/^[a-zA-Z0-9@._-]+$/`, both in the Zod config schema and at runtime via
  `assertSafeRunnerPaths()` before any SSH command that interpolates them.
  This is defense-in-depth against the Zod schema being bypassed by the
  `safeParse` fallback path in config loading.
- **ubuntu-latest-scanner**: Daily scan of `.github/workflows/*.yml` files in
  all cloned repos. Detects `runs-on:` values matching known GitHub-hosted runner
  patterns (`ubuntu-*`, `windows-*`, `macos-*`) and creates a deduped alert issue in the
  offending repo with the `Priority` label. Skips commented-out lines and handles both direct string and
  array forms of `runs-on`. Custom self-hosted runner labels (e.g. `ryzen`,
  `arm64`) are not flagged — detection is positive-match only, not a
  `self-hosted`-string check. Expression syntax (`${{ matrix.os }}`) is **not**
  flagged — runtime expressions are indeterminate at static analysis time and
  flagging them unconditionally produces false positives. False positives are
  treated as worse than false negatives for this scanner.
- **concurrency-scanner**: Daily scan of `.github/workflows/*.yml` files in
  all cloned repos. Detects three classes of concurrency misconfiguration:
  (1) missing top-level `concurrency:` groups — only flagged when
  `workflowBenefitsFromConcurrency()` returns `true` (PR-relevant triggers:
  `pull_request`, `pull_request_target`, `merge_group`; or `push` to non-default
  branches — bare `push` or `push` with non-`{main,master}` branch filters;
  `schedule`, `workflow_run`, `release`, and other event-only workflows are
  not flagged because per-branch cancellation provides no value there); also
  suppressed if any job uses dynamic concurrency (e.g., Vercel preview
  deployments with per-deployment groups, indicated by `${{ }}` in a job-level
  concurrency key), (2) job-level concurrency groups using static names (no
  `${{ github.ref }}` interpolation) **only** when `cancel-in-progress: true`
  (intentional serialization with `cancel-in-progress: false` is not flagged),
  and (3) `deployment_status`-triggered workflows using `${{ github.ref }}` in
  concurrency groups — `github.ref` always resolves to the default branch for
  deployment events, creating a global mutex across all PRs. Creates a deduped
  alert issue per repo with recommended fixes and the `Priority` label.
- **migration-scanner**: Daily scan of all cloned repos for directories
  containing incrementally-numbered migration files (e.g. `001_create_users.sql`).
  Detects migration directories via common paths (`migrations/`,
  `db/migrations/`, etc.) plus a shallow recursive scan (up to 4 levels deep)
  for any directory named `migrations`. Files with numeric prefixes of 6 or
  fewer digits are classified as incremental; 8+ digit prefixes that
  resemble dates or 10+ digit prefixes that resemble Unix timestamps are
  classified as date-based. If any date-based file exists in a directory
  (even alongside incremental files), the directory is considered
  mid-transition and is not flagged. Creates a deduped alert issue per repo
  with the `Priority` label, a table of violations, and recommended convention: `YYYYMMDDHHMMSS_description.ext`
  filenames, directory scanning (no barrel file), `schema_migrations` table
  for tracking, and out-of-order application support.
- **main-build-monitor** (not a scanner — a top-level job, see
  [jobs/main-build-monitor.md](jobs/main-build-monitor.md)): replaced the
  per-repo `notify-failures.yml` scanner in #2778. Rather than checking that
  each repo has wired up its own failure-notification workflow, Claws now
  watches default-branch builds centrally: every completed `push`/`schedule`
  run on a repo's default branch is read out of the `workflow_runs` table that
  `runner-metrics-sync` already populates, and the latest run per workflow
  drives the outcome. A failure that matches the transient-error heuristic
  (`isInfrastructureOutage`/`isPreRepoStepFailure`, or a `TRANSIENT_LOG_PATTERNS`
  hit in the single failed job's log tail) is re-run once — guarded by tip-SHA
  equality so a superseded run can never republish a stale artefact — and only
  reported if the retry fails too. Non-transient failures are filed straight
  away via `ensureAlertIssue` under `Build failure: <workflow name>` (no `bug`
  label), and the issue is closed automatically when a later run of the same
  workflow goes green. `workflow_dispatch` is excluded deliberately: a human
  pressing "Run workflow" sees their own failure.
- **cache-on-self-hosted-scanner**: Daily scan of `.github/workflows/*.yml` files
  in all cloned repos. Identifies jobs whose `runs-on` is a self-hosted runner
  and flags any cache-related step uses inside those jobs (`actions/cache`,
  `setup-*` actions with cache options). Self-hosted runners persist their
  workspace and caches between runs, making these steps redundant. Creates a
  deduped alert issue per repo with the `Priority` label. Uses `workflow-parser.ts`
  `JobInfo.steps` to inspect step `uses` fields and `StepInfo.with` for cache
  configuration keys. **Owner rationale (#2329, #2331)**: this is not only
  storage-quota waste — a `cache: npm`-style step on a self-hosted runner was
  the trigger event in the incident chain behind [runner-monitor](jobs/runner-monitor.md)'s
  job-in-progress cleanup guard (#2327): the multi-GB cache write filled
  `hetzner-beefy-actions` past the tier-1 threshold, runner-monitor's disk
  cleanup fired mid-restore, and wiped the live job's `_work/_temp` — failing
  that job *and* an unrelated repo's job on the same host with unrelated-looking
  errors (`ENOENT … cache.tzst`, a missing `set_output` file-command file).
  `claws`'s own `ci.yml` was itself a repeat offender here (6.58 GB of cache
  against the org's shared 2 GB quota, all from one `actions/setup-node`
  `cache: npm` step) before the full nix-devShell migration removed
  `actions/setup-node` — and its cache step — from `claws` entirely.
- **issue-comment-spam-scanner**: Daily scan of `.github/workflows/*.yml` files
  in all cloned repos. Detects workflows that create new issues for failures
  (`gh issue create`) and then post new comments on recurrence (`gh issue comment`)
  — this produces comment spam in alert issues. The scan uses raw text matching:
  flags files that contain both `gh issue create` and `gh issue comment` but do NOT
  already contain `gh issue edit`, `**Occurrences:**`, or `**First seen:**` (already
  migrated). Files where the only `gh issue comment` usage is within a `close --comment`
  invocation are not flagged. Creates a deduped alert issue per repo with a
  recommended fix (`gh issue view` + `awk` body-edit + `gh issue edit` pattern).
- **runner-os-scanner**: Daily scan of `.github/workflows/*.yml` files in all
  cloned repos. Flags jobs whose `runs-on` contains `self-hosted` but no OS label
  (`linux` or `macos`, case-insensitive). Jobs using dynamic expressions (`${{ … }}`)
  or custom non-`self-hosted` labels are not flagged. Creates a deduped alert issue
  per repo with the `Priority` label. Issue title: `Alert: self-hosted runner jobs
  missing OS label`. Uses `workflow-parser.ts` `JobInfo.runsOn` to inspect runner labels.
- **claude-config-scanner**: Daily scan of all cloned repos. Checks each repo for root
  instructions in `AGENTS.md` — the only root instructions file (#3224), so a surviving
  `CLAUDE.md` is itself a finding asking for its content to be folded into `AGENTS.md`
  and the file deleted — plus canonical role docs in
  `.agents/issue-refiner.md`, `.agents/issue-implementer.md`, and
  `.agents/pr-reviewer.md`. If a role doc is absent, the scanner asks the repo to add it.
  Uses `fs.existsSync` for each check (symlinks are acceptable). Alert title:
  `Alert: missing Claude agent configuration`.
- **dependabot-config-scanner**: Daily scan of all cloned repos. Walks each repo (max depth 3)
  for dependency manifests, mapping them to Dependabot `package-ecosystem` values, and compares
  them against `.github/dependabot.yml` as **(ecosystem, directory) pairs** — not by ecosystem
  alone, so a separate project like `bonkus`'s `apps/mobile` is not masked by a root-only entry.
  npm directories are anchored on lockfile presence, which drops workspace members covered by a
  root lockfile (emitting entries for those yields a config Dependabot errors on). Repos with no
  manifests, a Renovate config, or a committed `.claws/dependency-updates-optout` are left alone;
  an unparseable `dependabot.yml` logs a warning rather than filing an alert. Files a `Priority`
  issue containing the exact YAML to add, which the normal issue pipeline turns into the PR.
  Alert title: `Alert: missing dependency-update configuration`. Note Dependabot *alerts* are an
  org default needing no config — *version updates* are what this file enables. See
  [docs/jobs/dependabot-config-scanner.md](jobs/dependabot-config-scanner.md).
- **design-guidelines-scanner**: Daily scan of all cloned repos. Walks each repo (max depth 3,
  skipping `docs`/`.github` along with the standard vendor/build dirs) collecting UI evidence:
  framework dependencies (react, vue, svelte, next, tailwindcss, astro, solid-js, preact,
  @angular/core) parsed from each `package.json`, and up to 5 example paths with a UI file
  extension (`.html`, `.css`, `.scss`, `.sass`, `.less`, `.tsx`, `.jsx`, `.vue`, `.svelte`,
  `.astro`). A repo is judged to "have a UI" if any framework dependency matched, or at least 3
  UI files matched — the ≥3 threshold plus the `docs`/`.github` exclusion keep a stray
  `docs/coverage.html` in a backend repo from tripping it. Repos with a UI but none of
  `docs/DESIGN.md`, `DESIGN.md`, `docs/design-system.md`, `docs/DESIGN-SYSTEM.md`,
  `docs/design.md`, `.claude/rules/frontend.md`, `.claude/rules/design.md`, or a
  design/frontend/styling heading in `AGENTS.md` get an **unlabeled** chore issue with a starter
  `docs/DESIGN.md` template. Opt out per-repo via the `design-guidelines-scanner` job-disable
  config rather than closing the issue — `runRepoScanner` only dedupes against *open* issues, so
  a closed-as-won't-do issue is re-filed on the next daily run. Issue title:
  `chore: add frontend design guidelines (docs/DESIGN.md)`.
- **dynamic-workflow-runner-scanner**: Daily scan via the GitHub API, not the filesystem.
  Detects the same self-hosted-only violation as `ubuntu-latest-scanner` but for **dynamic
  workflows** — GitHub-generated jobs with no workflow file in the tree (Dependabot's updater,
  CodeQL default setup) — which the file-based scanner structurally cannot see. Fetches each
  repo's dynamic workflow runs, keeps only the latest run per distinct path, and inspects each
  job's runner identity (`runnerGroupName === "GitHub Actions"` or a label matching
  `^(ubuntu-|windows-|macos-)`). Files a `Priority` alert whose body states the exact remedy for
  Dependabot's updater specifically: its runner is an org-wide setting (Org Settings → Security →
  Advanced Security → Global settings → Dependabot → Runner label), not a per-repo one, so the
  scanner reports rather than attempting a per-repo fix. Issue title: `Alert: dynamic workflows
  are running on GitHub-hosted runners`. See
  [docs/jobs/dynamic-workflow-runner-scanner.md](jobs/dynamic-workflow-runner-scanner.md).

### Docker on NixOS Runners

`docker run -v "$PWD":/path` silently mounts an **empty** directory on the
self-hosted NixOS runners: the workspace checkout lives on a bind mount that
is private to the runner service unit's own mount namespace, so the Docker
daemon (running outside that namespace) resolves the host path in *its* own
namespace instead and finds nothing there. This is the same failure class
that broke `bin-scraper#250` and later `release.yml`'s container-based
`node_modules` build (#2351, added by #2348/#2349 to link native modules —
`node-pty`, `better-sqlite3` — against Debian glibc instead of the nix
devShell's glibc, which the non-nix Ubuntu deploy host can't resolve). The
fix is always the same shape: stream files **in** with
`tar -cf - <paths> | docker run -i ... IMAGE bash -c 'tar -xf - -C /dest && ...'`
and copy results **out** with `docker cp <container>:/path ./local-path` —
never a bind mount. `docker cp` also has the side benefit of extracting
client-side, so the copied-out files come back owned by the runner user with
no `chown` step needed.

### GitHub Actions Concurrency & Runner Priorities

GitHub Actions has no native job priority system. The "higher priority waiting
request" cancellation message comes from GitHub's concurrency model, not from
any configurable priority setting. When multiple jobs share the same
concurrency group (e.g. `group: self-hosted-runner` without per-branch
scoping), only one runs at a time across all branches. With multiple open PRs,
jobs queue up and get cancelled by newer pushes — producing systemic CI
failures.

**A concurrency group is not a queue — it holds one running + one pending.**
When a third job enters the same group, GitHub silently cancels the older
*pending* job. `cancel-in-progress: false` does not prevent this: it only
protects the job that is already *running*. So a group shared by 3+
jobs/workflows that can be triggered by the same push deterministically
evicts one of them on every push — even a correctly per-ref-scoped group
like `self-hosted-runner-${{ github.ref }}`, which looks safe by the
cross-branch rule above.

The fix is to **never share one group across 3+ jobs or workflows that can
trigger together**. Give each workflow its own group (`ci-${{ github.ref }}`,
`e2e-${{ github.ref }}`, …) and let runner-level queueing handle capacity —
runners already serialize work; a concurrency group is the wrong tool for
rationing runner slots. Reach for a shared group only where mutual exclusion
is genuinely required (a single deploy target, a shared preview
environment), and then only between at most two participants; beyond that,
use a real lock rather than a concurrency group.

**Diagnosis hint (ci-fixer symptoms).** A check that is **cancelled ~2
seconds in with zero steps executed** is concurrency-group eviction, not a
runner failure, a flake, or a lost runner. Re-running it without fixing the
group just re-rolls the dice — the re-run rejoins the same group and can be
evicted again. ci-fixer's automatic reruns usually mask this, so it stays
invisible until GitHub refuses a rerun (`cannot be rerun` /
`Resource not accessible by integration`, which Claws surfaces as the
`claws:not-rerunnable-run` PR comment) and retries stop — the failure mode
that stalled `St-John-Software/namey` PR #1652. When triaging repeated
zero-step cancellations, read the workflow files' `concurrency:` keys before
touching the runner.

Claws mitigates this in several ways:

- **Concurrency groups in own workflows**: `ci.yml` uses
  `group: ci-${{ github.ref }}` (per-branch, cancel-in-progress) and
  `release.yml` uses `group: release` (never cancel — only triggers on main).
  `release.yml`'s runs build `main` HEAD and skip a push run whose triggering
  commit already shipped (#3096), so the never-cancel group still bounds a
  merge burst to at most two releases instead of one per commit.
- **Throttled reruns in ci-fixer**: When 3+ PRs in the same repo have
  cancelled checks, ci-fixer throttles to 1 rerun per repo per cycle
  (prevents cascade while still making progress). Priority-labeled PRs
  are rerun first.
- **Priority-aware rerun ordering**: Reruns that pass bottleneck filtering are
  processed sequentially with a 2-second stagger. PRs with the `Priority`
  label are re-run first.
- **Concurrency scanner**: Daily scan detects misconfigured concurrency groups
  across all managed repos and files advisory issues with recommended fixes.

The `Priority` label affects Claws' internal Claude task queue and ci-fixer
rerun ordering, but cannot control GitHub's runner allocation.

### Image & Attachment Context

`images.ts`'s `processTextForImages` gives issue-refiner and issue-worker
prompt access to files attached to the native Claws issue being processed —
and nothing else. It lists the issue's attachments via
`getIssueAttachments`/`clawsIssues.listAttachments` and reads each one straight
off disk (`readIssueAttachment`); there is no network fetch, no forge token,
and no `body_html`. Images are saved into the worktree under
`.claws-images/`; attachments are saved under `.claws-attachments/` with
optional guarded text previews in the prompt. Binary files and ZIP archives
are retained as local bytes rather than silently skipped, but archives are
not extracted or trusted. Links to files hosted elsewhere — GitHub
`user-attachments`, Forgejo assets, third-party image hosts — are listed in a
guarded `## Files Not Downloaded` prompt section instead of being fetched;
this never produces a `⚠️ Could not download` comment or a `[claws-error]`
alert, since a forge link an agent can't reach isn't a Claws fault. A
`[claws-error]` alert fires only when a file actually listed in the native
store can't be read. PR reviews get no image or attachment context at all —
pull requests stay on the forge and have no native store, so review-addresser
never calls `processTextForImages`. The importer's `fetchIssueFile` (used by
`copyForgeFiles` in `issue-importer.ts`) is the only remaining network
downloader in `images.ts`; it copies a forge issue's files into the native
store once, at import time, and shares the SSRF guard and GitHub/Forgejo
token handling that used to serve the agent-time path directly.
`shopping-comment-processor.ts` reads comment-embedded images the same
native-only way, via its own `collectCommentImageRefs`.

### Parallel Repo Processing

Both `issue-dispatcher` and `pr-dispatcher` process repos concurrently using
`Promise.allSettled(repos.map(...))`. One failure in a repo does not block
others. The rate-limit circuit breaker check at the start of each repo callback
short-circuits only that repo — other repos proceed normally.

### Fast-Checks Guidance

`agent-context.ts` exports `FAST_CHECKS_GUIDANCE` (injected into issue-worker
and review-addresser prompts) and `CI_FIXER_FAST_CHECKS_GUIDANCE` (injected into
ci-fixer prompts). Both instruct Claude to prefer fast local checks (type-check,
lint, unit tests) and leave slow ones (integration tests, Docker, external
services) to CI, which is the source of truth for them. The ci-fixer variant
notes that CI reruns automatically on push rather than "after the PR is opened".

`RUNNER_POLICY_CONTEXT` (also in `agent-context.ts`) is injected into all three
issue-refiner prompt builders (fresh plan, refinement, follow-up), both
issue-worker prompt builders, and both pr-reviewer prompt builders
(`buildStandardReviewPrompt` and the per-file `filePrompt` for large PRs).
It instructs Claude not to suggest or add GitHub-hosted runners
(`ubuntu-latest`, `windows-latest`, `macos-latest`, etc.) — this organisation
uses only self-hosted runners due to cost, with no macOS exception. The
constant also instructs agents to always include an OS label when using
`self-hosted` runners (`[self-hosted, linux]` or `[self-hosted, macos]`),
mirroring the enforcement done by the `runner-os-scanner` detector. Together,
these constants apply the runner policy proactively at plan/implementation/review
time rather than reactively after a violation is committed.

### Documentation as Context

Issue-refiner, issue-worker, improvement-identifier,
idea-suggester, and triage-claws-errors prompts instruct Claude to read
`docs/OVERVIEW.md`
(and linked docs) before starting work. This gives Claude accumulated
architectural context about each repository.

### Provider-Agnostic Memories

The Claude CLI's memory feature (`~/.claude/projects/<slug>/memory`) is per-host scratch
space, and in the k8s pod that host is ephemeral — rebuilt from Secrets every boot with no
restore. The durable copy is the `claude-memories` branch that `claude-memory-backup` pushes
to hourly (#2757); `doc-maintainer` reads *that branch*, not any local store, so the fold
survives every pod restart and sees notes from every host that has ever worked on a repo,
not just the one running the current job. Rather than inline that content into every agent
prompt (#2666), which would pay the token cost on every run regardless of whether anything
changed, `doc-maintainer` reads the branch once per repo (`await collectRepoMemories(repo)`,
`agent-memory.ts`) and asks an agent to refine durable facts into `docs/` — the one context
store every provider's prompts already read. The
refinement cost is paid once nightly per repo instead of on every agent invocation, and the
result — unlike the raw notes — is verified against the current code before being kept.
Refined output can also land in agent-guidance markdown (`.agents/*.md`, `.skills/**/SKILL.md`)
when a memory or captured intent item is a lesson about how agents should work rather than a
fact about the code — see
[doc-maintainer.md](jobs/doc-maintainer.md#agent-guidance-maintenance).

### Client TypeScript Pipeline

Client-side JavaScript is authored as TypeScript in `src/client/*.ts` and
compiled/bundled by `scripts/build-client.mjs` (esbuild) into
`src/resources/*.generated.ts` constants. The pattern mirrors
`tailwind-css.generated.ts`: each generated file exports a string constant
containing an inline `<script>…</script>` block, which page builders
interpolate directly into HTML. `tsconfig.client.json` type-checks client
sources with DOM libs; the generated `.ts` files are excluded from the main
server `tsconfig.json`. The `npm run build:client` script type-checks then
bundles; `npm run build` runs `build:client` first. Generated files are
checked into the repo so CI and production require no extra build step beyond
`npm run build`.

### Prompt Resource Injection

The idea-suggester's `buildPrompt()` accepts a `resources` parameter for
injecting reference material into prompts. Currently used to provide
marketing strategy knowledge (from `src/resources/marketing.ts`, sourced
from the Marketing-for-Founders repository) so Claude considers marketing
tactics when suggesting ideas. The resource is inlined as a TypeScript string
constant to avoid runtime file I/O and build-path issues.

Frontend guidance is injected into every prompt built by `issue-worker.ts`,
`issue-refiner.ts`, and `review-addresser.ts`, but which version gets injected is
decided per worktree by `frontendContext(wtPath)` (`src/agents/agent-context.ts`)
— progressive disclosure rather than a fixed block. It checks `docs/DESIGN.md`,
`DESIGN.md`, then `.claude/rules/frontend.md` under the worktree; if one exists,
the prompt gets a one-line pointer naming that path as authoritative. Only when
the repo has no design doc at all does it fall back to the exported
`FRONTEND_AESTHETICS_CONTEXT` — the full anti-slop block (distinctive typeface,
one palette as custom properties, layered background, motion behind a
`prefers-reduced-motion` guard), which also tells the agent to write its invented
choices into `docs/DESIGN.md` so the repo converges after one UI ticket. Both
versions self-gate ("only if this task touches user-facing HTML/CSS/UI"), like
`RUNNER_POLICY_CONTEXT`. A nonexistent worktree path simply yields the fallback.
The `design-guidelines-scanner` job is the other half of this: it files the issue
that gets a repo's first `docs/DESIGN.md` written in the first place.

### Branch Naming

| Agent / Job | Pattern |
|-----------------|---------|
| planner (issue-refiner) | `claws/plan-<N>-<hex4>` |
| implementer (issue-worker) | `claws/issue-<N>-<hex4>` |
| ci-fixer / review-addresser | Uses existing PR branch |
| triage-claws-errors | `claws/investigate-error-<N>-<hex4>` |
| doc-maintainer | `claws/docs-<YYYYMMDD>-<hex4>` |
| improvement-identifier | `claws/improve-<hex4>` (analysis worktree only; no PR is opened) |
| idea-suggester | `claws/ideas-<hex4>` |

### PR Title Conventions

- `fix: <subject>` — single-PR issue implementations (subject from the generated `TITLE:` marker, else the issue title)
- `fix: <phase title> (X/Y)` — multi-PR issue phases
- `docs: update documentation for <repo>` — doc maintenance

The issue ref is carried by the `claws/issue-<ref>-…` branch and the `Closes #<ref>` / `Part of #<ref>` body line, never by the title; the trailing `(X/Y)` is what phase coverage and the issue auditor parse.

### Issue Title Conventions (Claws-created)

- `security: <title>` — security finding raised by improvement-identifier (one issue per finding; deduped by title prefix)
- `<title>` (raw) — improvement finding filed by improvement-identifier (one issue per finding; no prefix added)
- `Alert: self-hosted runner jobs missing OS label` — runner-os-scanner alert
- `[runner-monitor] Persistent high disk` — runner-monitor disk alert
- `[claws-error] <fingerprint>` — internal Claws error reports
- `[disallowed-actor] @<login> is blocked from Claws automation` — filed in `SELF_REPO` when the issue-dispatcher skips an issue whose author is not in `ALLOWED_ACTORS` (and is not a CI failure alert); one issue per actor, occurrence-tracked so the body is updated rather than new comments posted; does not fire for dependency-update bots (Renovate, Dependabot), which are skipped silently

### Duplicate PR Guards

PR-creating jobs check for existing open PRs before creating new ones to
prevent pile-up when previous PRs haven't been merged:

- **doc-maintainer**: Skips if an open `claws/docs-*` PR exists (see
  [doc-maintainer.md](jobs/doc-maintainer.md) for the HEAD-unchanged skip
  gate and its exemptions, including missing agent-guidance files)
- **improvement-identifier**: Skips analysis entirely if an open `security: ` issue exists *and* ≥3 issues carrying the improvement footer are open. Skips security filing if any `security: ` issue is open. Skips improvement issue filing if ≥3 improvement issues are open, or if security findings were filed this tick
- **idea-suggester**: Before filing each idea, looks it up with
  `findIssueByExactTitle()` against the repo's open issues and skips it if a
  matching title is already open. Filing is sequential so `createIssue`'s
  cache invalidation makes each lookup see the issues filed earlier in the
  same run
- **ci-fixer**: Uses consolidated per-repo `[ci-unrelated]` issues rather
  than per-fingerprint issues, so all unrelated CI failures for a repo
  are tracked in a single issue. Within that issue, `fileUnrelatedIssue()`
  further dedups at comment granularity via an in-memory
  `reportedUnrelatedOccurrences` set keyed by `unrelatedOccurrenceKey()` — the
  failing run's ID parsed out of its run URL, or a `pr+fingerprint` fallback
  when the URL carries none — so a run that's still failing across several
  ~5-minute dispatcher sweeps gets exactly one comment instead of a fresh one
  per sweep (bin-scraper#250: 5 comments for one run in 16 minutes, #2338).
  Same in-memory trade-off as `deadRerunIds` above: a process restart costs at
  most one extra duplicate comment per run, not unbounded reposting

### Merge Button Visibility

Never gate the dashboard's Squash & Merge button behind label/CI-state
heuristics (e.g. "only when `Ready` is applied" or "only when CI is green") —
surface all relevant signals (labels, CI/pipeline status, infra-path warnings)
beside each PR instead and let the human operator decide, because per-criteria
gating is fragile and hides information the operator needs to judge
mergeability themselves (#1204). That rule was written for the since-removed
Queue page. The surviving button on `/prs` (`buildMergeAction()` in
`src/pages/lists.ts`) is gated at the owner's later request (#2110) on conflicts,
failing or pending CI, and review issues/escalation — but it renders the blocking
reason in the button's place, and CI and review status on every row regardless.

### Item Skip & Prioritize

Individual issues/PRs can be skipped or prioritized via `skippedItems` and
`prioritizedItems` in `config.json` (arrays of `{repo, number}`), or via
the Skip/Prioritise buttons on `/prs` and `/issues` (`POST /queue/skip`, `/queue/prioritize`);
skipped items are restored from the Skipped section of `/issues` (`POST /queue/unskip`).
Skipped items are excluded from all job processing via `isItemSkipped()`.
Prioritized items are processed before others in job queues via
`isItemPrioritized()`. Both lists are hot-reloadable.

### Per-Repo Job Disabling

Individual jobs can be disabled for specific repos via `disabledJobsByRepo` in
`config.json` (a `Record<string, string[]>` mapping repo full names to arrays
of job names) or via the `/jobs` matrix page in the dashboard. The matrix UI
shows repos on one axis and jobs on the other with checkboxes. Changes are
written to `config.json` and hot-reloaded. `isJobDisabledForRepo(jobName,
repoFullName)` is called in each job's `run()` function to filter out disabled
repos before processing. For example, `ci-fixer` can be disabled per-repo this
way to suppress automated CI fix attempts on repos where manual intervention is
preferred.

### Job Pause/Resume

Individual jobs can be paused and resumed via the dashboard (`POST /pause/:job`)
or pre-configured via `pausedJobs` in `config.json`. Paused jobs skip their
scheduled ticks but can still be triggered manually.

### Disabled Agents

Agents within `issue-dispatcher` and `pr-dispatcher` can be individually disabled
via `disabledAgents` in `config.json` (array of agent names) or via the config
page checkboxes. Valid agent names: `planner`, `implementer`, `ci-fixer`,
`review-addresser`, `reviewer`, `merger`. A disabled agent's phase is silently
skipped — the parent agent job still runs and processes other phases. Legacy
`pausedJobs` entries for the old job names are automatically migrated to
`disabledAgents` on config load.

### Push Branch Concurrency

`pushBranch()` in `claude.ts` uses a fetch-rebase-push retry loop (up to 3
attempts) to handle concurrent pushes to the same PR branch. The initial
`git fetch` uses an explicit refspec (`refs/heads/${branchName}:refs/remotes/origin/${branchName}`)
rather than passing `branchName` bare — `branchName` is `pr.headRefName`, an
attacker-controlled GitHub value (a PR author can name their branch e.g.
`--upload-pack=...`), and `execFile` runs `git` without a shell so this isn't
shell injection but is git **option injection**: a bare argument starting
with `-` is parsed by git as a flag rather than a ref name. Prefixing with
the literal `refs/heads/` makes the token unparseable as an option (#1861).
When multiple jobs operate on the same branch (e.g. review-addresser and ci-fixer),
non-fast-forward rejections are resolved by fetching the latest remote state,
rebasing local commits on top (using `--rebase-merges` to preserve merge
commit topology), and retrying. The `--rebase-merges` flag is critical when
ci-fixer's `resolveConflicts()` creates merge commits — without it, plain
rebase would decompose merge commits into individual constituent commits,
causing conflicts. For new branches (where fetch fails because the branch
doesn't exist on the remote yet), rebase is skipped and push proceeds
directly. When a rebase conflict occurs, `pushBranch` falls back to merging
the remote branch — this handles the common case where both sides
incorporated the same upstream changes via different merge paths. If the
merge also conflicts, the operation aborts with a `PushConflictError` — a named error class that the error reporter suppresses (logs at warn, does not create a `[claws-error]` issue) since this is a transient race resolved by the next dispatcher cycle. GitHub can also reject a *new-branch* push with
`cannot lock ref 'refs/heads/<branch>': reference already exists` when
receive-pack creates the ref after our client's ref advertisement was taken —
this is treated identically to a non-fast-forward rejection: retry the
fetch-rebase-push loop, then throw `PushConflictError` once attempts are
exhausted (#2834).

As a defense-in-depth measure, the pr-dispatcher skips review-addresser
for PRs with active ci-fixer work in the same cycle. During Phase 1
(identification), the dispatcher collects PR numbers that have `fix` or
`conflict` ci-fixer tasks. Phase 3 (review-addresser) skips those PRs
with a `continue` guard — they are picked up on the next cycle (~60s
later). This prevents concurrent pushes to the same branch. The
dispatcher also skips CONFLICTING PRs in the review-addresser phase,
since ci-fixer handles conflict resolution.

### Commit Tag

Doc-maintainer commits include `[doc-maintainer]` in the message. This is used
by `getLastDocMaintainerSha()` to detect whether docs are already up-to-date.

### Per-Item Timeout Escalation

When a Claude process times out on a specific issue/PR, the
`timeout-handler.ts` module:

1. Counts recent timeouts for that item (2-hour sliding window via
   `db.countRecentTimeouts()`)
2. If fewer than 3 timeouts: escalates the per-item timeout by 1.5x (capped
   at 6 hours), persisted in `itemTimeoutOverrides` config
3. If 3+ timeouts: auto-skips the item via `gh.skipItem()` (adds to
   `skippedItems` config and removes from queue cache)
4. Posts a comment on the source issue/PR via `reportTimeoutOnItem()` with
   timeout count, escalation details, and skip status

Jobs call `getItemTimeoutMs()` before invoking Claude to retrieve any
per-item override. `getItemTimeoutMs()` applies a floor at the global
`CLAUDE_TIMEOUT_MS` default — legacy overrides from previous lower-default
eras are silently ignored so items aren't cut short. All jobs that invoke
Claude must use both `getItemTimeoutMs()` (before invocation) and
`handleTimeoutIfApplicable()` (in error handlers) for consistent timeout
tracking and escalation.

### Plain-Text Markers (No HTML Comments)

Claws does not use HTML comments (`<!-- ... -->`) as machine-readable markers.
All structured markers in GitHub comments and PR bodies are plain text:

- `review-addressed: <SHA>` — review-addresser marks addressed feedback (backward-compatible regex handles legacy HTML-comment form in old comments)
- `Reviewed commit: \`<SHA>\`` — pr-reviewer records the last-reviewed commit
- `recommended-model: sonnet` / `recommended-model: opus` — pr-reviewer's model hint
- `review-provider: openrouter` / `review-provider: claude` — legacy marker from a previous OpenRouter routing experiment; no longer written but still parsed for backward compatibility (strips the marker from displayed comment text)
- `plan-updated-after-phase:N` — plan-parser deduplication marker
- `no-commit:<phase>` — dedup marker in issue-worker no-commit feedback (one per phase; `no-commits-warning` global marker removed in #851)
- `CLAWS_PLAN_OCCURRENCES: N` — appended to every plan comment by issue-refiner, recording the `**Occurrences:**` count from the issue body at planning time; parsed by `parsePlannedOccurrences()` and used by issue-dispatcher to trigger re-planning when recurrence count doubles
- `CLAWS_DUPLICATE_OF: #N` — stamped by issue-refiner onto the short "See #N" plan it posts after a duplicate verdict; read by issue-worker to append `Closes #N` to the PR body. The planner's own four outcomes are **not** markers: they travel on the `claws_report_outcome` tool ([Planner output via MCP tools](#planner-output-via-mcp-tools)), so a plan body naming `CLAWS_NO_CODE_CHANGES`, `CLAWS_BLOCKED`, `CLAWS_TRANSFER_TO:` or the duplicate marker constant is inert prose and is posted verbatim (#3155).
- `CLAWS_TRANSFERRED_FROM: owner/repo#N` — stamped on the routing comment right before `gh.transferIssue()` is attempted; read back by `alreadyTransferredInto()` to cap transfers at one hop, comparing the stamped repo against the *current* repo so a failed transfer (stamp names the still-current repo) doesn't permanently block a retry.

Agent prompts include explicit instructions not to use HTML comments in output.

**Exception**: `ci-fixer.ts`'s `reportRunNotRerunnable()` delimits its not-rerunnable
note within the PR body's manual-action section with an HTML-comment marker pair
(`NOT_RERUNNABLE_MARKER`/`NOT_RERUNNABLE_END`, #2218) rather than a plain-text one.
Unlike the markers above — which are meant to stay visible as part of a
human-readable comment — this one exists purely so a later call can find and
replace its own note without disturbing another agent's manual-action text sharing
the same heading; rendering it invisible in GitHub's Markdown view is the point,
not a violation of the convention's rationale.

### Zod Runtime Validation

All external data entering the system is validated with Zod schemas rather than
cast with `as T`. The key surfaces:

- **`github.ts`** — `safeJsonParse<T>(schema, raw, context)` requires a Zod schema
  at every call site. It handles `gh` returning an empty string `""` for empty list
  results (e.g. `gh pr list` when no PRs exist) by falling back to `[]` before
  parsing. `ghJson<T>` forwards the schema. All `gh` output parsed this way: PR
  lists, issue lists, check status, reactions, labels, etc.
- **`server.ts`** — POST request bodies (`/queue/merge`, `/queue/skip`,
  `/queue/prioritize`, etc.) are parsed with Zod schemas. WebSocket messages
  (`input`/`resize`) use a `discriminatedUnion` schema.
- **`slack.ts`** — Slack API response shapes (`postMessage`, `getReactions`) are
  validated on receipt.
- **`mcp-server.ts`**, **`agents/ci-fixer.ts`**, **`github-app.ts`** — AI-extracted
  JSON and GitHub App API responses are validated.
- **`transcribe.ts`**, **`ollama-rate-limit-classifier.ts`** — External API responses
  validated before field access.
- **`jobs/whatsapp-handler.ts`**, **`jobs/improvement-identifier.ts`**,
  **`jobs/idea-suggester.ts`** — AI-extracted JSON outputs validated before use.
- **`config.ts`** — Config file parsing validated with a full schema (no
  `passthrough()` — schema surfaces unknown/cruft fields).

The rule: no `JSON.parse(...) as T` casts. Every parse site uses a Zod schema so
shape mismatches throw a `ZodError` with a readable message rather than producing
silent type-unsafe values.

### GitHub App Authentication

Claws requires GitHub App authentication for its own GitHub and git operations.
On startup, `ensureGitHubAppConfigured()` validates that either global
`githubAppId` + `githubAppPrivateKeyPath` are set with an existing key file, or
that `githubOwnerAppCredentials` includes at least one fully-resolvable per-owner
entry; otherwise startup fails. Per-owner credentials take priority and allow
different GitHub Apps for different organisations. All `gh` and `git` subprocess
invocations are passed short-lived installation tokens via env var injection
(`GH_TOKEN`, `GITHUB_TOKEN`). Tokens are minted per-owner via RS256 JWT →
GitHub API → installation access token, with a 10-minute expiry buffer.
Concurrent token refreshes for the same owner are deduplicated via a promise
cache. PRs and comments appear under the App bot identity.

Agents that operate in a repo worktree now receive a short-lived GitHub App
installation token as `GH_TOKEN`/`GITHUB_TOKEN` via `RunClaudeOptions.githubTokenOwner`,
minted in `runClaudeInner` and layered in by `runCliProcess` under the backend
env. This replaces an undocumented dependency on the host's ambient
`gh auth login` credential; a mint failure is `log.error`'d (Slack) and the
agent degrades to ambient auth rather than crashing.

The option is opt-in per call site, and the set of sites that opt in is a
security decision, not a mechanical sweep: an installation token is **owner-wide**,
not repo-scoped (#2246), so every site that receives one widens what a
prompt-injected agent could reach. Covered today are the agents that already act
on a repo under an explicit issue/PR mandate, where the token merely replaces the
ambient `gh auth login` credential they were already using: `issue-refiner`
(planning, refinement and follow-up passes), `issue-worker`, `ci-fixer`
(conflict, fix and revert passes), `review-addresser`, and `pr-reviewer`.
`src/claude.test.ts` asserts the per-file call-site counts, *and* asserts that no
other file under `src/agents/` or `src/jobs/` sets the option — so both a silent
omission and a silent widening fail the suite.

Not covered, by design:

- Calls that deny Bash, and therefore `gh`, outright — `issue-refiner`'s
  complexity classifier, `escalation-reviewer`, `email-monitor` and
  `whatsapp-handler` via `disallowedTools: TEXT_ONLY_DISALLOWED_TOOLS`, and
  `shopping-sourcer` via its own explicit deny list. A credential there would be
  pure attack surface with no caller able to use it.
- Closed-form text transforms with no repo mandate: `public-snapshot-sync`'s
  README-tailoring and commit-message passes.
- Calls whose cwd is not a repo checkout at all (`sessions.ts` on `$HOME`,
  `issue-worker`'s tmpdir summariser, `ci-fixer`'s `process.cwd()` triage).
- Worktree agents that read lower-trust or open-ended input and are *not*
  tool-stripped — `public-repo-scanner`, `improvement-identifier`,
  `idea-suggester`'s analysis pass, `doc-maintainer`, `triage-claws-errors`,
  `problematic-pr-diagnoser`, and `issue-refiner`'s step-back pass. These would
  work mechanically, but each needs its own risk analysis of what an owner-wide
  token in that context permits before it is granted one; widening to them is
  deliberately left to a follow-up change. They continue to use whatever
  ambient credential the host provides.

Known limitation:
installation tokens live 1 hour while agent timeouts run up to 6 hours — the
token is minted once, immediately before spawn, so a run whose first `gh` call
happens more than ~55 minutes in will get a 401 instead of silently degrading;
this is accepted rather than solved with a refresh mechanism, since planner/worker
runs are normally minutes long and an explicit 401 beats invisible degradation.

### Security Model

Because Claude runs with `--dangerously-skip-permissions`, all user-supplied
input paths must be guarded upstream. Six primary defenses:

- **Query param escaping**: The `/logs/issue` page escapes the `repo` query param through both `encodeURI()` and `escapeHtml()` (in that order) before interpolating it into an `href` attribute — preventing reflected XSS via a crafted `repo` value containing a double-quote. A repo-membership check (`listRepos()`) also gates the handler: unknown repos return 404 rather than rendering an empty page with the attacker-controlled value.
- **Configured-repo allowlist on dashboard mutation routes**: `isConfiguredRepo(repo)` in `server.ts` checks a client-supplied `repo` string against `listRepos()` and is applied to every dashboard route that mutates GitHub state or reads issue-scoped logs — `/queue/merge`, `/queue/mark-refined`, `/queue/mark-automerge`, `/queue/mark-problematic`, `/queue/unmark-problematic`, `POST /board/move` (the newest of them — it rewrites lifecycle labels and closes issues), and `GET /logs/issue`. `/board/move` accepts an **empty** `repo` for a Claws-native ref, whose card may carry none — but it does not then write through the empty string, which would be the one way past this gate: it resolves the repository from the issue's own record (the single entry on `record.repos`) and puts *that* back through `isConfiguredRepo` before any write. Only an issue with no single repository resolves to `""`, and it has no repository to check. It then goes further than the gate, because a configured repo is not necessarily the *issue's*: for a native ref a `repo` that is named on the wire must also be on `record.repos`, or `claws-issues.ts` would tag its `label-added`/`issue-closed` events at a repository the issue has nothing to do with. The GitHub App installation token these routes run under can reach every repo in the installation, which is typically broader than Claws' configured/managed repo set, so without this check a dashboard client could direct a mutation (merge, label) at a repo Claws doesn't manage (#2221). `/queue/skip`, `/queue/unskip`, `/queue/prioritize`, `/queue/deprioritize` are deliberately exempt — they only write local config (`skippedItems`/`prioritizedItems`) and never call GitHub, and gating them would block un-skipping an item whose repo was later removed from the managed list.
- **Repo-scoped installation tokens in image/attachment downloads**: GitHub App installation tokens are owner-wide, not repo-scoped, so `images.ts`'s `shouldAttachGitHubToken()` withholds the token whenever a URL found in issue/PR text (`extractRepoFromGitHubUrl()`) positively identifies an `owner/repo` that doesn't match the repo currently being processed — otherwise a comment in one repo could pull private content out of a sibling repo under the same installation (#2246). See the `images.ts` entry in [modules.md](modules.md) for the full mapping.
- **Fork PR filtering**: All PR-processing jobs (pr-reviewer, ci-fixer,
  auto-merger, review-addresser) skip fork PRs via `isForkPR()`
  (checks the `isCrossRepository` field). This prevents untrusted external
  contributors from injecting content that Claude would execute with full
  host access.
- **Allowed actor gating**: `isAllowedActor()` in `github.ts` checks whether
  a user is in the `ALLOWED_ACTORS` list or is the authenticated `gh` user.
  Applied at multiple layers:
  - **issue-dispatcher** gates on issue *author* in both Phase 1 (refined → implementer) and Phase 2 (fresh plan/refine → planner) — issues from non-allowed actors are logged and skipped; the dispatcher also Slack-notifies and files a tracked `[disallowed-actor] @<login> is blocked from Claws automation` issue in `SELF_REPO` (via `ensureAlertIssue`, one issue per actor with occurrence tracking; individual item dedup via `markUntrustedActorNotified` in `notified_untrusted_actors` DB table) so the operator can grant an `allowedActors` exception. One CI bot exception exists: `isCiAlertBotAuthor()` grants a full pass-through for any issue authored by the GitHub Actions runner bot (`github-actions[bot]` / `app/github-actions`) — any such issue is dispatched into the refine-and-fix pipeline regardless of title. Dependency-update bots (Renovate, Dependabot) are still skipped, but silently: `isDependencyBotAuthor()` matches their logins (`renovate`, `renovate[bot]`, `app/renovate`, `dependabot[bot]`, `app/dependabot`) and short-circuits before `notifyUntrustedActorSkip`, so no Slack message or `[disallowed-actor]` issue is filed for their generated tracking issues (e.g. Renovate's Dependency Dashboard).
  - **issue-refiner** gates the auto-`Refined` label application for `[ci-unrelated]` issues on the issue author (defense-in-depth against escalation from untrusted actors).
  - **issue-refiner** also filters comments by actor — only comments from allowed actors trigger plan refinement or follow-up.
  - **triage jobs** check issue authors.
  For the self-repo (`SELF_REPO`), issue
  processing includes a collaborator check via the GitHub API. A
  `normalizeBotLogin()` helper normalizes both the incoming login and self-login
  before comparing: `gh` CLI returns GitHub App authors as `app/<slug>` in
  `--json author` output, while the REST `/app` endpoint returns `<slug>[bot]`.
  `normalizeBotLogin` converts `app/<slug>` → `<slug>[bot]` so comparisons
  work regardless of which API surface produced the login. `isAllowedActor`
  passes `SELF_REPO.split("/")[0]` to `getSelfLogin()` to ensure the correct
  App credentials are used (critical in multi-owner setups where different owners
  have different App slugs).
- **Injection-detection visibility**: `guardContent()` in `prompt-guard.ts` must
  never fail silently — a detected injection (score ≥ 10) is redacted before it
  reaches the model *and* posted back as a comment on the originating issue/PR
  (`formatInjectionComment()` / `postInjectionComment()`) quoting the matched
  pattern name, phrase, and offset, deduplicated per item via `POSTED_COMMENTS`
  (capped at 1000 keys with FIFO eviction, not a TTL — a TTL would let the same
  ⚠️ comment repost on the same item every time it's rescanned, exactly the
  spam `issue-comment-spam-scanner` exists to flag; #2291).
  A Slack-only or log-only alert is not sufficient — a human reviewing the item
  must be able to see what was flagged and why without cross-referencing Slack
  history (#1275).

### PR Review Comment Protocol

Every terminal code path in the pr-reviewer must leave a comment with the
standard `REVIEW_HEADER` (`## PR Review`) and a `Reviewed commit: \`SHA\``
marker (plain text). This invariant prevents infinite re-review loops — without
a commit marker, `hasNewCommitsSinceLastReview()` cannot determine whether
re-review is needed, causing the PR to be re-processed every cycle. Three terminal states:

1. **Empty diff** — posts "no net changes" comment with marker
2. **No issues found** — posts "Reviewed — no issues found" comment with marker, adds `Ready` label
3. **Issues found** — posts review feedback with marker (review-addresser auto-picks up)

On re-review (new commits since last review), the reviewer always posts a
new comment rather than editing the previous one. This preserves discussion
threads and approval signals on previous reviews. The dispatcher calls
`hasNewCommitsSinceLastReview(repo, prNumber)`, which internally finds the
latest review comment and compares its commit marker against the current
HEAD. If no new commits are found, the PR is skipped. If new commits exist
(or no prior review exists), `processPR(repo, pr)` is called to generate
and post a fresh review.

**Large PR diff handling**: The reviewer uses a two-phase diff strategy. Phase 1
attempts to fetch the full diff with a 200 MB buffer. If the buffer is exceeded
(or the diff exceeds 50,000 chars), Phase 2 switches to per-file mode: each
changed file is diffed individually; files larger than 20,000 chars receive a
dedicated Claude call with a structure-focused prompt (schema validity, format
consistency, field naming); smaller files are reviewed together in a single call
with the standard review prompt. Results from all segments are merged into one
`## PR Review` comment. The `generatePRDescription*` functions also use the
larger 200 MB buffer, truncating to 30,000 chars after fetch.

**Provider for PR reviews**: The pr-reviewer always uses Claude CLI with
`provider: "claude"` (#1879 — the reviewer was given real tool access so it can
verify git facts with real tool calls before
asserting them; see `REVIEW_VERIFICATION_CONTEXT` in `agent-context.ts`). A previous routing
mechanism (`resolveReviewDispatch()`) that dispatched to OpenRouter/Qwen for
smaller PRs was removed after review quality degraded. The `REVIEW_PROVIDER_PATTERN`
regex (`review-provider: (openrouter|claude)`) is retained in the code for
backward compatibility — existing comments with that marker are parsed to strip
the marker from displayed text. `isVagueReview()` validates reviewer output
before posting — comments with empty `Lines:` fields or missing required details
are suppressed entirely rather than posted as low-quality feedback.

**Dynamic context budgeting**: `buildReviewContext()` accepts an optional byte
budget (`contextBudgetBytes(diffBytes, reassessmentBytes)`) and passes it to
`loadRepoDocs()` to cap how much of `docs/OVERVIEW.md` is included. The budget
is derived from `REVIEW_MODEL_MAX_INPUT_TOKENS` (30,000) × `BYTES_PER_TOKEN`
(3.5) minus the diff and reassessment sizes — preventing over-large context
even with Claude's 200K window, keeping reviews focused.

### MCP Server Context

Claude sessions spawned by Claws can access operational state via the
built-in MCP server (`mcp-server.ts`). `writeClawsMcpConfig()` in `claude.ts`
generates an MCP config file that includes the Claws state server and
optionally additional MCP servers (e.g. Playwright for shopping-sourcer). The Claws MCP
server provides eight core tools (`claws_status`, `claws_task_history`, `claws_open_prs`,
`claws_config`, `claws_issue_phases`, `claws_get_issue`, `claws_list_issues`,
`claws_wait_for_change`) plus `claws_set_session_title`
and `claws_set_session_status` when spawned for an interactive session, plus
`ha_list_entities` / `ha_api_request` when `HOME_ASSISTANT_BASE_URL` and
`HOME_ASSISTANT_TOKEN` are configured, giving Claude visibility into what Claws
is currently doing, recent task history, operator configuration, and live Home Assistant entity
state and services. The state server is launched via `process.execPath` so it always runs on the same Node runtime as the Claws process whose `node_modules` (and `better-sqlite3` native prebuild) it loads.

`claws_set_session_title` and `claws_set_session_status` are the only *write*
tools the state server exposes to a session; the planner tools (`claws_save_plan`,
`claws_report_outcome`, `claws_step_back_verdict`) are registered only in a config
written for one planner run and act on that run alone — see
[Planner output via MCP tools](#planner-output-via-mcp-tools). `claws_set_session_title` sets the description
shown for a session on the dashboard's sessions list, and pins it against the
30 s auto-summariser. `claws_set_session_status` (#3083) records the session's
self-reported state — `working`, `monitoring`, `waiting` or `done` — shown with
its age in the Active sessions table's Status column; `SESSION_WORKFLOW_PROMPT`
tells the session to update it at every transition. The status is deliberately
self-reported by the agent: it replaces the removed tmux-activity heuristic
(#2955, removed in #2973/#2988), which could not tell agent output from keystroke
echo and repaints. Neither tool takes a target session parameter: it is fixed by
`CLAWS_MCP_SESSION_ID`, baked into the config's `env` block when
`writeClawsMcpConfig()` is called with a `sessionId` (interactive session spawns
only — agent call sites never pass it), so a session can change only itself and
no other session. Both tools are registered only when that env var is present.

`includeHomeAssistant` defaults to `false` and every call site must opt in
explicitly (#2064 — `ha_api_request` can invoke arbitrary HA services, e.g.
unlocking doors, so handing it to fleet agents working on unrelated repos was
a standing risk). Call sites pass
`{ includeHomeAssistant: isHomeAssistantConfigRepo(fullName) }`
(`isHomeAssistantConfigRepo()` in `home-assistant.ts`, a case-insensitive
match against `HOME_ASSISTANT_CONFIG_REPO`, default
`"St-John-Software/home-assistant-config"`) — issue-refiner (planner),
issue-worker (implementer), ci-fixer, review-addresser, pr-reviewer,
problematic-pr-diagnoser, and improvement-identifier all gate this
way, so HA tools are wired in only when the agent is actually working on the
HA config repo. `triage-claws-errors.ts` always operates on `selfRepo` and
passes no HA option at all, relying on the `false` default. The
`homeAssistantContext()` prompt text (which tells the model the HA MCP tools
exist) is gated by the same `isHomeAssistantConfigRepo(fullName)` check at
each call site, so agents on other repos are no longer told about tools they
don't have.

`claws_issue_phases` (#2594) is read-only and proxies `GET /api/issue-phases`:
given an issue with a multi-PR plan, it lists the plan's steps and which are
already covered by an open/merged PR or a `claws-phase-done:` claim comment
(see [Multi-PR Phase Coverage](#multi-pr-phase-coverage)). It exists so an
interactive session overseeing a multi-PR issue can check current coverage
before implementing a step by hand, instead of duplicating a step the pipeline
(or another session) already completed.

`claws_get_issue` and `claws_list_issues` are the tracker's read tools,
proxying `GET /api/issues/:id` and `GET /api/issues`. They exist so a session
can read a `clw_…` issue's own body, comments and posted plan before applying
**Refined**, instead of applying it on trust or handing plan review back to
the user. `claws_get_issue`
returns the issue plus its comments and current plan (the plan comment itself
is left out of `comments`); `claws_list_issues` lists open native issues,
optionally for one repo, so a session can check for an existing issue before
filing a duplicate with `claws_create_issue`.
