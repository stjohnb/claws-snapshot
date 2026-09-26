# Model Selection

**Reference.** Read this when you need to know which model an agent run will
use, or where to change it. For provider *selection* (which of Claude, Codex and
OpenCode runs an item) see the Model Selection section of
[patterns.md](patterns.md); this doc is about tiers and the models they resolve to.

## The tier vocabulary

Every agent asks for a **tier**, never a concrete model id. There are four,
best first:

| Tier | Use for |
|---|---|
| `fable` | The best model each provider offers. Fresh planning by default, and any later phase an operator escalates by hand. |
| `opus` | Deep analysis: architectural work, novel logic, multi-file investigation. |
| `sonnet` | Well-defined changes following an established pattern. The default when nothing says otherwise. |
| `haiku` | Trivial changes with no logic to get wrong — typos, comments, docs, one-line fixes. |

`haiku` was called `cheap` until the vocabulary was unified, and `cheap` is still
**read** everywhere it can appear: plan comments that were posted before the
rename, `recommended-model:` / `review-model:` markers on open PRs, and
persisted `reviewModelTier` config. Nothing writes it any more. The single
sanctioned way to turn a string into a tier is `normalizeTier(raw)` in
`model-selector.ts` — it maps `cheap` to `haiku` and returns `null` for anything
that is not a tier, so a caller falls back rather than trusting model output.

`fable` is deliberately not a tier `classifyComplexity()` may answer: escalating
to the best model available is an operator decision, not a classification.

## The tier table

`getModel(tier, provider)` resolves a tier to a concrete model id, and
`MODEL_TIER_TABLE` (also in `model-selector.ts`) describes the whole grid — the
config key, environment variable, default and operator-facing label of every
cell. The `/config` page renders that table directly, so a new tier or key shows
up in the UI without touching the page.

| Tier | Claude | Codex | OpenCode |
|---|---|---|---|
| `fable` | `claudeFableModel` (default `fable`) | `codexFableModel` (defaults to `codexDefaultModel`) | `opencodeFableModel` (defaults to `opencodeBestModel`) |
| `opus` | CLI alias `opus` | `codexDefaultModel` | `opencodeBestModel` |
| `sonnet` | CLI alias `sonnet` | `codexLightModel` | `opencodeAdequateModel` |
| `haiku` | `claudeCheapModel` (empty falls back to the `haiku` alias) | `codexCheapModel` | `opencodeCheapModel` |

Claude's `opus` and `sonnet` cells have no config key at all, and the `fable`
cell defaults to the literal string `fable`: `claude --model <alias>` resolves an
alias to the newest model in that tier, so these stay correct across model
releases with no code change. Codex ids are run through `resolveCodexModel()`
(stale-alias repair) and validated against `codex debug models` where available;
an empty Codex key means "let the CLI pick the account's default". OpenCode ids
must carry the `openrouter/` prefix.

See [configuration.md](configuration.md) for every key's default and environment
variable.

## The per-issue model plan

Every issue has a **model plan**: an optional `{provider, tier}` cell for each
pipeline phase, stored in the `issue_model_plan` table (see
[database-schema.md](database-schema.md#issue_model_plan-table)) and resolved by
`resolveModelPlanCell()` in `src/model-plan.ts`. It is keyed by repository and
issue ref, so forge issues have one too; only native issues can be edited from
the dashboard.

| Phase | Agent | Default when no cell and no older input names one |
|---|---|---|
| `requirements` | requirements-writer, writing and refining the requirements record | claude / `sonnet` |
| `plan` | issue-refiner, fresh plan | claude / `fable` (at maximum reasoning effort) |
| `plan-refine` | issue-refiner, re-plan on feedback and follow-up replies | claude / `opus` for a re-plan; `sonnet` for a follow-up reply |
| `implement` | issue-worker | weighted draw / the plan's recommendation, else `sonnet` |
| `review` | pr-reviewer | weighted draw / the PR's `review-model:` marker, else `reviewModelTier` |
| `ci-fix` | ci-fixer (CI fix, conflicts, unrelated-fix revert) | weighted draw / `classifyComplexity()` |
| `review-address` | review-addresser | weighted draw / the reviewer's `recommended-model:` tier |

A cell is either **explicit** — set by an operator in the Model plan grid on the
issue page or the New Issue form — or **suggested**, written by the planner. The
planner may end a plan with an optional line after the two recommendation lines:

```
**Model plan:** `implement=claude/sonnet` `review=opus` `ci-fix=haiku`
```

Each cell is `phase=provider/tier` or `phase=tier`. `plan-parser.ts`'s
`parseModelPlanLine()` drops unknown phases, providers and tiers, and reads only
the last line that *starts* with `**Model plan:**` outside a code fence, so a plan
that quotes the format in its prose is not mistaken for one that sets it (the two
recommendation lines are read the same way). A suggested `plan` or `requirements` cell
is dropped: only an operator moves fresh planning or the requirements writer,
so the planner cannot steer the runs that feed it. When a plan
has no such line, its `Recommended implementation model` and `Recommended review
model` lines become the suggested `implement` and `review` cells. Every new plan
replaces the previous suggestions; a suggested write never overwrites an
explicit cell.

The grid's selects show only explicit cells. A planner suggestion is named in the
blank option (`default (suggested: opus)`, after the fable clamp), so saving the
form unchanged never turns a suggestion into an explicit cell; a blank phase
clears only its explicit cell. The form is offered, and the save route accepts it,
for any issue linked to a repository; the cells are stored under the issue's
primary repo. Every phase resolves them from there, whichever repo it runs in:
a review, review-address or CI-fix round on a multi-repo issue's PR in another
of its repos reads the same cells.

The issue page shows each phase's resolved concrete model id (`sonnet` on Codex
reads `gpt-5.6-terra`) and which input won; a board card whose issue has any
explicit cell carries a one-line summary of them.

## Which tier a run gets

Provider and tier resolve independently, in this order, highest first:

1. **An explicit cell** in the issue's model plan. A cell that names a provider
   pins it for the whole run (`strictProvider`), exactly like a `Use *` label —
   unless that provider is disabled, in which case the cell's provider is ignored
   and the reason lands in the "Models used" attribution.
2. **A suggested cell.**
3. **The agent's own legacy input**, passed as the fallback: the plan's
   `**Recommended implementation model:**` for the implementer; the PR's
   `review-model:` marker, then `reviewModelTier`, for the reviewer;
   `classifyComplexity()` for ci-fixer; the reviewer's `recommended-model:`
   markers for the review-addresser. `Plan: Deep` is this layer's tier for both
   planning phases and for a requirements write. A requirements refine run
   passes `sonnet` and ignores `Plan: Deep`, like a follow-up reply. A follow-up reply to a question comment resolves the
   `plan-refine` cell too, but its fallback tier is `sonnet` and it ignores
   `Plan: Deep` — answering a question is not re-planning.
4. **A `Use Claude` / `Use Codex` / `Use OpenCode` label** for the provider.
5. **The phase default** from the table above.
6. **The weighted provider draw** over the enabled `aiProviders`, and `sonnet`
   for a tier nothing named.

A phase default provider is a preference, not a pin: planning prefers Claude but
`runClaude` can still fall back to another provider, re-deriving the model from
the tier (`getModel("fable", …)` for a fable plan). A PR with no linked issue —
Dependabot, a hand-rolled branch — has no model plan and resolves from step 3
down, exactly as before model plans existed.

### The fable guardrail

A **suggested** cell naming `fable` for any phase other than `plan` is clamped
to `opus` at resolution time, and shown as `opus` on the issue page. The same
clamp applies to a `fable` in the agent's own legacy input (step 3 above): plan
prose, a PR's `review-model:` marker and a reviewer's `recommended-model:`
marker are agent-written or PR-author-editable text, so `review-model: fable`
in a PR description runs the review on `opus`. Only an operator-set input can
put a later phase on `fable` — an explicit cell, or the `Plan: Deep` label for
`plan-refine` or a requirements write. Fresh planning is the one phase that spends Fable by default.

`fable` stays out of `classifyComplexity()`'s answers for the same reason:
escalating to the best model available is an operator decision, not a
classification.

The planner's `DEEP_PLANNING_CONTEXT` prompt block ("this issue was explicitly
labelled for deep planning") needs both the `Plan: Deep` label and a resolved
`fable` tier: a default fable plan gets no such text, and neither does a
`Plan: Deep` issue whose explicit cell moved planning off fable.

The `Use *` and `Plan: Deep` labels still work, one layer below the model plan.
Retiring them in favour of the grid is follow-up work (a label migration across
every managed repo).
