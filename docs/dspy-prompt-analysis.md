# Analysing Claws prompts with DSPy

**Deep dive.** Read this when you're evaluating DSPy for analysing Claws'
agent prompts (#1828, analysis only). For where prompts actually live in
code, see modules.md's `agents/*.ts` entries instead.

Issue #1828 asked how [DSPy](https://github.com/stanfordnlp/dspy) could be
used to analyse the prompts Claws sends to its agents. This doc records what
DSPy is and isn't, where Claws prompts live, how they're captured, and how to
run the offline analysis tooling.

## What DSPy is and isn't

DSPy is a **Python-only** framework — it has no JS/TS API and cannot lint or
statically analyse a TypeScript prompt string in place. Instead, it reframes
an LLM task as a typed **Signature**, wraps it in a **Module**
(`dspy.Predict` / `dspy.ChainOfThought`), and runs an **Optimizer**
(`BootstrapFewShot`, `MIPROv2`) that *compiles* an improved prompt — but only
given a dataset of real example input/output pairs and an evaluation metric.
There is no way to run DSPy directly against the Claws codebase; it needs
captured prompts and their outputs as data.

## Where Claws prompts live

Every agent prompt flows through one chokepoint: `runClaude(prompt, cwd,
options)`, exported from `src/claude.ts`. Prompts are built inline across
`src/agents/*` and `src/jobs/*` and passed as the first argument; the
optional system prompt is `options.appendSystemPrompt`.

## Capture (off by default)

`runClaude` wraps every call and, when capture is enabled, writes a JSONL
record to `~/.claws/prompt-captures/prompts-YYYY-MM-DD.jsonl`
(`PROMPT_CAPTURE_DIR` in `src/config.ts`), one file per day. Each line has:

```json
{
  "ts": "2026-07-03T12:00:00.000Z",
  "label": "issue-refiner",
  "tier": "sonnet",
  "model": "claude-sonnet-5",
  "cwd": "/home/brendan/.claws/worktrees/...",
  "appendSystemPrompt": "...",
  "prompt": "...",
  "output": "...",
  "ok": true,
  "errorMessage": null
}
```

`label` comes from `options.captureLabel`, threaded into the highest-value
call sites (`issue-refiner`, `issue-worker`, `pr-reviewer`, `ci-fixer`,
`review-addresser`); other call sites fall back to the worktree's basename.

Capture was on by default while gathering data for the #1844 DSPy analysis
above; that analysis is now complete, so the default was flipped to opt-in
for any future collection window.

**Owner requirement (#1844, #1828 origin, #1924):** capturing *real production*
prompts was explicitly permitted for this analysis — "I'm ok to start capturing
production prompts… We can write to a well known location on disk for analysis and
easy cleanup" — and specifically to chase `pr-reviewer` cost/behaviour problems.
That permission was scoped to the analysis: once it was done, capture had to flip
back to **opt-in by default** (#1924), because it accumulates sensitive
prompt/output data and there is deliberately no retention automation. Do not
re-enable it globally without a fresh, time-boxed reason. (The `pr-reviewer` cost
follow-on from the same thread — skip re-review when the reviewable diff hasn't
changed after a rebase/merge even though the head SHA has, #1923 — is recorded in
[jobs/pr-dispatcher.md](jobs/pr-dispatcher.md).)

**Controls:**
- `CLAWS_PROMPT_CAPTURE=1` (or `true`) enables capture. It is **off by
  default**; unset, `0`, or `false` means no capture.
- `CLAWS_PROMPT_CAPTURE_DIR=/some/path` overrides the capture location (only
  takes effect when capture is enabled).
- Cleanup is manual: delete the directory, or delete individual
  `prompts-YYYY-MM-DD.jsonl` day-files. There is no retention/pruning
  automation — this is intentional.

**Sensitive-data warning:** captured prompts embed repo file contents,
issue/PR text, and diffs, which can include secrets or other sensitive
material. They live under `~/.claws/` on the single-tenant self-hosted host,
outside any git repo. Never commit them to a repo, and never copy them off
the host without review.

## How to analyse captured prompts

See `tools/dspy/`. `analyze_prompts.py` reads the JSONL and prints per-label
stats (count, prompt length distribution, failure count) with no API key
required, plus an optional `--optimize` flag that runs a small DSPy
`BootstrapFewShot` example against one agent's captured prompts/outputs.

## Limits / non-goals

This is a research spike, not a live pipeline:
- Nothing here is wired into the live agent request path — DSPy does not
  see or influence any prompt Claws actually sends.
- Optimization needs a hand-built, per-agent metric and a labelled
  trainset — the `--optimize` example is illustrative, not production-ready.
- No auto-optimization loop exists or is planned by this doc.
