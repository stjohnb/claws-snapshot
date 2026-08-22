# Model Selection Restructure — Phase 1

## Goal

Reserve Claude (Opus/Sonnet) quota for workflows that genuinely need tool use.
Text-only workflows (PR review, triage, utility text-gen) route through
OpenRouter directly, using models like Qwen 2.5 Coder 32B that don't require
tool-use support at the endpoint.

Every call site that invokes an agent must now declare `capability: "tool-use"`
or `capability: "text-only"` explicitly. There is no default — the contract
change forces the declaration at the type level.

**Note on the planner:** the issue-refiner is semantically text-only (it
produces a markdown plan comment, no file edits), but it stays pinned to Claude
opus/sonnet because it sits at the top of the implementation chain. Degrading
plan quality propagates downstream — every implementer PR is only as good as
the plan it starts from. The `capability: "text-only"` declaration is paired
with an explicit `provider: "claude"` pin in issue-refiner.

## Key shape changes

### Contract

- `RunClaudeOptions` gains a required `capability: "tool-use" | "text-only"` field.
- `getModel(tier, capability, provider)` — capability is a required argument.
- `runClaude` picks its fallback order from the capability-specific config, not
  from a single global `PROVIDER_FALLBACK_ORDER`.
- `runClaude` honours explicit `{ provider, model }` pins on the first attempt
  — only re-derives the model via `getModel()` when falling back to a different
  provider. This lets callers like pr-reviewer pin an exact model ID for the
  direct-HTTP path without the fallback loop stomping on it.

### Providers

Four backends are wired into the dispatch layer:

- **`claude`** — Claude Code CLI subprocess. Tool-use capable. Default primary
  for tool-use workflows.
- **`codex`** — OpenAI Codex CLI subprocess. Tool-use capable. Available as a
  fallback.
- **`opencode`** — OpenCode CLI subprocess, which talks to OpenRouter under the
  hood. Tool-use capable. Multi-turn, session-managed, but always sends tool
  schemas in the request — so the underlying model must support function
  calling.
- **`openrouter`** — Direct OpenRouter HTTP via `fetch`. No subprocess, no tool
  schemas, single-turn chat completion. Unlocks non-tool-capable models
  (notably Qwen 2.5 Coder 32B) for pure text-generation workflows like PR
  review.

### Config

The single `PROVIDER_FALLBACK_ORDER` retires. In its place:

- `TOOL_USE_PROVIDER_FALLBACK_ORDER` (default `["claude"]`) — for workflows that
  actually edit files, run `git`, call `gh`, etc.
- `TEXT_ONLY_PROVIDER_FALLBACK_ORDER` (default `["openrouter"]`) — for workflows
  that only produce text output (reviews, triage, descriptions). The planner
  is the exception: it's text-only but pins `provider: "claude"` explicitly.

Model configs per provider tier:

- `CLAUDE_CHEAP_MODEL`
- `CODEX_DEFAULT_MODEL`, `CODEX_LIGHT_MODEL`, `CODEX_CHEAP_MODEL`
- `OPENCODE_BEST_MODEL`, `OPENCODE_ADEQUATE_MODEL`, `OPENCODE_CHEAP_MODEL`
- `OPENCODE_TEXT_BEST_MODEL`, `OPENCODE_TEXT_ADEQUATE_MODEL`,
  `OPENCODE_TEXT_CHEAP_MODEL` — used when opencode is invoked for a text-only
  workflow. Defaults to Gemini Flash because models here must support tool
  calling.
- `OPENROUTER_BEST_MODEL`, `OPENROUTER_ADEQUATE_MODEL`, `OPENROUTER_CHEAP_MODEL`
  — used by the direct-HTTP openrouter provider. Defaults to
  `qwen/qwen-2.5-coder-32b-instruct` for best/adequate (code review quality)
  and `google/gemini-2.5-flash-lite` for cheap. No tool-use requirement here
  because the direct-HTTP path doesn't send tool schemas.

### Planner prompt guidance

The planner prompt emphasizes that implementation will run on a smaller model
(typically Sonnet via Claude, sometimes dropping further in phase 2), so the
plan must be specification-grade: exact file paths, concrete edits, explicit
guardrails against common failure modes, and minimal ambiguity. The planner
itself stays on Opus/Sonnet to ensure plan quality.

## Workflow classification

| Workflow                                | Capability  | Provider pinned | Notes                                            |
| --------------------------------------- | ----------- | --------------- | ------------------------------------------------ |
| `issue-worker` (implementer)            | `tool-use`  | claude          | writes files, runs git                           |
| `ci-fixer` (fix + conflict resolver)    | `tool-use`  | claude          | writes files, runs git                           |
| `review-addresser`                      | `tool-use`  | claude          | applies review suggestions                       |
| `doc-maintainer`                        | `tool-use`  | claude          | edits docs, commits                              |
| `improvement-identifier` (impl phase)   | `tool-use`  | claude          |                                                  |
| `pr-reviewer`                           | `text-only` | **openrouter**  | direct HTTP → Qwen 2.5 Coder 32B                 |
| `issue-refiner` (planner)               | `text-only` | **claude**      | pinned to Claude for plan quality                |
| `classify-complexity`                   | `text-only` | (fallback)      | single-word classification                       |
| `claude.ts` utility text-gen            | `text-only` | claude          | PR descriptions, commit diagnoses                |
| `triage-claws-errors`                   | `text-only` | (fallback)      | posts a markdown investigation                   |
| `triage-kwyjibo-errors`                 | `text-only` | (fallback)      | posts a markdown triage                          |
| `idea-suggester`                        | `text-only` | (fallback)      | produces markdown ideas                          |
| `improvement-identifier` (analysis)     | `text-only` | (fallback)      | produces markdown analysis                       |
| `qa-phase`                              | `text-only` | (fallback)      | produces markdown validation                     |
| `email-monitor`                         | `text-only` | (fallback)      | extraction / recipe gen                          |
| `whatsapp-handler`                      | `text-only` | (fallback)      | chat reply                                       |

Workflows marked `(fallback)` use whatever is first in
`TEXT_ONLY_PROVIDER_FALLBACK_ORDER` — `openrouter` by default.

## Production-hotfix history

- **2026-04-15 (#940):** Dashboard misreported OpenRouter as "not configured"
  when the opencode CLI was authenticated via its own `opencode auth login`.
  Fix: `isOpenCodeBinaryAvailable()` checks `$PATH` + known installer dirs,
  and the dashboard surfaces both signals (`claws key`, `opencode CLI`).
- **2026-04-15 (#941):** `pr-reviewer` was failing immediately with "No
  endpoints found that support tool use". Root cause: opencode always sends
  tool schemas, and Qwen 2.5 Coder 32B has no tool-capable OpenRouter
  endpoint. Hotfix: swap `OPENCODE_TEXT_*` defaults to Gemini Flash
  (tool-capable, cheap).
- **2026-04-15 (#942):** Add a direct OpenRouter HTTP provider that
  bypasses opencode entirely for pure text-gen, letting us use Qwen 2.5
  Coder 32B (and any other model, tool-capable or not) for PR review. Revert
  the planner migration — planner stays pinned to Claude opus/sonnet for
  plan quality.
- **2026-04-15 (#944):** Close the reviewer context gap from #942. Since
  the direct-HTTP reviewer has no filesystem tools, claws pre-loads codebase
  context into the prompt itself: top-level `*.md` files from `docs/`
  (produced and maintained by the doc-maintainer job), plus the post-change
  full content of every code file touched by the PR. This surfaces surrounding
  code, imports, and cross-file invariants the raw diff hunks hide.
- **2026-04-15 (this PR):** OpenRouter routed one of our reviews to a Qwen 2.5
  Coder 32B provider with a **32k** context window (not the theoretical 128k)
  and the enrichment-plus-diff blew the limit. Two changes in response:
  - **Smart doc selection.** Instead of loading every doc under `docs/`,
    always include `OVERVIEW.md` and then only include topic docs whose
    filename tokens overlap with the changed file paths or the PR title.
    Token match is lowercased and split on `/` `-` `_` `.` etc., min length 3.
    E.g. a PR touching `src/db/schema.ts` pulls in `docs/database-schema.md`;
    a PR titled "Add /api/search endpoint" pulls in `docs/api-design.md`.
    Irrelevant topic docs are skipped entirely.
  - **Tighter budgets** to fit a 32k-token provider comfortably: 12kB/doc,
    20kB total docs section, 15kB/changed-file, 60kB total enrichment (was
    20kB, 60kB, 30kB, 120kB respectively). At ~4 chars/token that leaves
    ~7k tokens of enrichment in the worst case, plus room for the diff
    (≤12k tokens), prompt scaffolding, and the model's response within 32k.

  A longer-term fix — pinning a specific OpenRouter provider/model combo
  with a guaranteed larger context window — is a follow-up candidate if the
  tight budgets start dropping useful context on large PRs.

## Checklist

### Core contract
- [x] Add `Capability` type to `model-selector.ts`
- [x] Update `getModel(tier, capability, provider)` signature
- [x] Update `getReviewModel` to require capability
- [x] Add required `capability` field to `RunClaudeOptions`
- [x] Update `runClaude` to use capability-specific fallback order

### Config
- [x] Replace `providerFallbackOrder` with `toolUseProviderFallbackOrder` + `textOnlyProviderFallbackOrder`
- [x] Add `opencodeTextBestModel` / `opencodeTextAdequateModel` / `opencodeTextCheapModel`
- [x] Update `loadConfig` / `reloadConfig` / `ConfigFile` / env-var handling

### Dashboard / server
- [x] Update `src/server.ts` POST /config handler
- [x] Update `src/pages/config.ts` config UI — two fallback orders, text-model fields

### Migrate call sites to text-only
- [x] `src/agents/pr-reviewer.ts` — all three review paths
- [x] `src/agents/issue-refiner.ts` — plan generation (both), complexity classify
- [x] `src/classify-complexity.ts`
- [x] `src/claude.ts` — generatePRDescription, generateDocsPRDescription, diagnoseNoCommits, regeneratePRDescription
- [x] `src/jobs/triage-claws-errors.ts`
- [x] `src/jobs/triage-kwyjibo-errors.ts`
- [x] `src/jobs/idea-suggester.ts` (both call sites)
- [x] `src/jobs/improvement-identifier.ts` (analysis phase)
- [x] `src/jobs/qa-phase.ts`
- [x] `src/jobs/email-monitor.ts` (both call sites)
- [x] `src/jobs/whatsapp-handler.ts`

### Declare tool-use call sites
- [x] `src/agents/issue-worker.ts` (implementer + tmpdir call)
- [x] `src/agents/ci-fixer.ts` (main fix + conflict resolver + classify call)
- [x] `src/agents/review-addresser.ts`
- [x] `src/jobs/doc-maintainer.ts`
- [x] `src/jobs/improvement-identifier.ts` (implementation phase)

### Planner prompt
- [x] Update `issue-refiner` planner instructions to guide a less-capable implementer

### Tests
- [x] Update `src/model-selector.test.ts`
- [x] Update `src/claude.test.ts` mocks + option calls
- [x] Update `src/server.test.ts`
- [x] Update `src/agents/issue-worker.test.ts`

### Docs
- [x] `docs/OVERVIEW.md` — replace `PROVIDER_FALLBACK_ORDER` refs with two-order model
- [x] This plan doc

---

# Phase 2 — Tool-use reduction

## Goal

Shrink the tool surface area each agent needs so more workflows can flip to
`text-only`, and so the tool-use workflows that remain have a smaller, auditable
blast radius. The principle: **claws owns orchestration, the agent owns
judgment**. Anything claws can do deterministically (git, gh, CI polling, PR
creation) should not be delegated to the agent.

## Approach

There are two tiers of reduction, ordered by risk:

**Tier A — Lift `gh` out of the agent.** The agent continues to edit files and
run `git` inside the worktree, but claws takes over all GitHub operations (PR
creation, comment posting, status reads, label management). This is low-risk
because the agent still operates in its familiar loop; we're just removing
tools it rarely needs to touch.

**Tier B — Lift `git` out of the agent.** The agent writes to the worktree but
never runs `git commit` / `git push`. Claws commits and pushes after the agent
finishes, using the diff of the worktree. This narrows the agent's tool surface
to filesystem edits only, and makes "did the agent produce real changes?"
trivially observable from claws' side (no need to parse agent output for
commits). It also means a failed agent leaves no partial git state to clean up.

**Tier C (aspirational) — Lift file edits out.** The agent produces structured
edit instructions (JSON blocks of `{ file, old, new }` or similar), claws
applies them. This would flip `issue-worker` / `ci-fixer` / `review-addresser` /
`doc-maintainer` to fully text-only. High risk — models struggle with producing
precise diffs at scale — so treat as a spike, not a commitment.

## Checklist — Tier A (lift `gh` out)

- [ ] Audit every agent prompt for `gh` tool references. Catalogue each one.
- [ ] For each agent that currently runs `gh pr create` / `gh pr comment` /
      `gh pr view` / `gh run view`:
  - [ ] Move the gh call into the job-level TS code after the agent finishes.
  - [ ] Strip the `gh` instructions from the prompt (and verify the agent
        doesn't hallucinate them back).
  - [ ] Pass any fetched data (CI logs, PR bodies, existing comments) into the
        prompt as pre-loaded context instead of asking the agent to fetch them.
- [ ] Remove `gh` from the MCP server permissions list. If a workflow genuinely
      needs it, add it back with a comment explaining why.
- [ ] Integration-test: run `issue-worker` and `ci-fixer` end-to-end on a test
      repo and verify no `gh` invocations occur inside the agent.

## Checklist — Tier B (lift `git` out)

- [ ] Audit agent prompts for `git commit` / `git push` / `git status` /
      `git diff` references.
- [ ] Replace the "commit your changes" prompt instructions with "edit files
      directly; do not run git". The agent stops managing commits entirely.
- [ ] Add a post-agent commit step to each tool-use job:
  - [ ] `claude.commitAgentChanges(wtPath, messageSource)` helper that:
    - Detects whether the agent made any changes (`git status --porcelain`)
    - Writes a commit with a message derived from job + issue/PR number (no
      LLM needed for trivial messages; optionally ask the agent for a message
      as part of its output when meaningful)
    - Pushes via the existing `claude.pushBranch` helper
- [ ] For workflows that need multiple commits (multi-phase implementers):
      decide whether to collapse to a single commit per phase or to let the
      agent emit commit markers in its text output that claws splits on.
      Recommend: single commit per phase — simpler, and the PR description
      already captures the "what" at a higher level.
- [ ] Remove `git` from the MCP server permissions list.
- [ ] Integration-test each tool-use workflow after the change.

## Checklist — Tier C (spike only, no commitment)

- [ ] Build a small prototype: `issue-worker` receives the plan + file contents,
      produces a JSON edit script, claws applies + commits + pushes.
- [ ] Measure success rate over ~50 real issues. Compare to the current
      tool-calling baseline.
- [ ] If success rate is within 5% of the tool-calling baseline, promote to a
      real phase. Otherwise, shelve and document why.

## Expected outcomes

- `doc-maintainer`, `review-addresser`, and `improvement-identifier` (impl) can
  likely flip to **text-only** after Tier B, because their edits are
  mechanically applicable from a diff.
- `issue-worker` and `ci-fixer` stay tool-use through Tier A/B but with a
  dramatically smaller tool surface (filesystem-only).
- Tier C is the only path to making `issue-worker` fully text-only.

---

# Phase 3 — Shadow-run + quality validation

## Goal

Before trusting Qwen-on-OpenRouter with production PR review quality, run it
alongside the current Claude-based reviewer and compare outputs. Avoid the
failure mode where text-only routing quietly degrades review quality for weeks
before anyone notices.

## Checklist

- [ ] Add a `CLAWS_SHADOW_REVIEW_PROVIDER` config flag. When set, `pr-reviewer`
      runs the review twice — once with the configured text-only provider, once
      with the shadow provider — and posts only the primary review.
- [ ] Persist both outputs in the `tasks` table (new column `shadow_output`).
- [ ] Add a dashboard page `/review-shadow` that lists PRs with both reviews
      side by side, plus a simple "same / different / shadow-better /
      primary-better" human rating widget.
- [ ] Run shadow mode for 7 days covering ≥30 PRs.
- [ ] Compute divergence stats:
  - Rate of issues flagged by primary but not shadow (false negatives on
    shadow side)
  - Rate of issues flagged by shadow but not primary (potentially missed by
    shadow, or primary missed a real issue)
  - Agreement rate on `NO_ISSUES_FOUND` verdicts
- [ ] Decision gate: if shadow agreement is ≥80% and no high-severity
      divergences, promote Qwen to primary. Otherwise:
  - Tune the Qwen prompt (Phase 4)
  - Or keep the review path on Claude and accept the quota cost
- [ ] Remove the shadow-run infrastructure or keep it behind the flag for
      future model-swap validation.

## Out of scope for Phase 3

- Shadow-running non-review workflows (plans, triage) — review is the biggest
  quality-sensitive text-only workflow, so validating it is enough to inform
  the rest.

---

# Phase 4 — Prompt tuning for smaller models

## Goal

Optimize prompts for the text-only workflows so that less-capable models (Qwen
Coder 32B, Gemini Flash, etc.) produce output closer in quality to what Opus or
Sonnet would have produced.

## Principles

1. **More scaffolding, less freedom.** Smaller models do better when the
   expected output format is rigid and examples are provided inline.
2. **Preload context, don't ask for it.** Instead of "read OVERVIEW.md",
   include the relevant OVERVIEW excerpts in the prompt.
3. **Fewer decisions per turn.** Break compound prompts into sequential
   single-decision calls where possible.
4. **Explicit failure modes.** Tell the model exactly what NOT to produce —
   smaller models are more prone to verbose preambles, speculation, and
   inventing file paths that do not exist.

## Checklist

- [ ] `pr-reviewer` prompt:
  - [ ] Add 2–3 few-shot examples of good reviews (real past reviews from the
        repo history, redacted)
  - [ ] Add an explicit "refuse to invent line numbers" guardrail
  - [ ] Compress the reassessment-needed section; smaller models get lost in it
- [ ] `issue-refiner` prompt:
  - [ ] The `IMPLEMENTER_GUIDANCE_INSTRUCTIONS` block from Phase 1 assumes the
        planner is Opus/Sonnet. If the planner itself is now Qwen, the block
        has to be re-evaluated — can Qwen produce specification-grade plans, or
        do we need to keep the planner on Claude for quality?
  - [ ] Decision: if Qwen plans are too loose, add a config to pin the planner
        provider independently of the text-only fallback order.
- [ ] `triage-*-errors` prompts: constrain the output to a strict JSON-or-markdown
      template. Smaller models drift into free-form prose otherwise.
- [ ] `generatePRDescription` and friends: already short prompts, probably fine.
      Spot-check a few outputs.
- [ ] Capture prompt-quality regressions in dashboard metrics (e.g. % of
      reviews with recommended-model marker present, % of plans that parse
      cleanly through `parsePlan`).

## Out of scope for Phase 4

- Fine-tuning a custom model. Out of scope for claws and its budget.
- Prompt versioning infrastructure. Keep it as inline constants unless the
  churn becomes a real problem.

---

# Phase priority / sequencing

1. **Phase 1** (this PR) — contract change + text-only routing. Mechanical.
2. **Phase 3** — shadow-run validation. Can start immediately after Phase 1
   merges; the data informs whether Phase 4 is even needed.
3. **Phase 2 Tier A** — lift `gh` out. Mechanical, low risk, clear win.
4. **Phase 4** — only if Phase 3 data shows quality regression. Targeted.
5. **Phase 2 Tier B** — lift `git` out. After Tier A is stable.
6. **Phase 2 Tier C** — spike only, gated on real measurement.

Phases 2 and 3 are independent and can run in parallel. Phase 4 is a
downstream of Phase 3's findings.
