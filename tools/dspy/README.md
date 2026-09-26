# DSPy prompt analysis

Offline, manual tooling for analysing prompts Claws sends to its agents,
using [DSPy](https://github.com/stanfordnlp/dspy). This is **not** part of
the Node.js service, its build, or CI — there is no `.ts` here, and it is
excluded from `tsc`/`vitest` naturally.

## Background

Capture is **off by default (opt-in)**. Set `CLAWS_PROMPT_CAPTURE=1` on the
systemd host for a collection window to have Claws capture every
`runClaude()` prompt/output pair to
`~/.claws/prompt-captures/prompts-YYYY-MM-DD.jsonl` during normal operation.
See `docs/dspy-prompt-analysis.md` for the full design writeup, including the
JSONL schema, the capture on/off switches, and sensitive-data handling.

## Setup

```sh
cd tools/dspy
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Usage

Print per-label stats (count, prompt length stats, failure count) for all
captured prompts:

```sh
python analyze_prompts.py ~/.claws/prompt-captures/
```

Filter to one agent's prompts:

```sh
python analyze_prompts.py ~/.claws/prompt-captures/ --label issue-refiner
```

Run the optional DSPy optimization example (requires `ANTHROPIC_API_KEY` and
a `--label`) — this compiles a small `dspy.ChainOfThought` program against
the captured prompt/output pairs for that label and prints the optimized
prompt:

```sh
ANTHROPIC_API_KEY=... python analyze_prompts.py ~/.claws/prompt-captures/ --label issue-refiner --optimize
```

This tooling is offline and manual by design — it does not modify or feed
back into the live agent request path.
