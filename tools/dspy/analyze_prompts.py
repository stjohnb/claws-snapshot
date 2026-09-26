#!/usr/bin/env python3
"""Offline analysis of Claws prompt-capture JSONL files.

Usage:
    python analyze_prompts.py [path] [--label LABEL] [--optimize]

`path` may be a single .jsonl file or a directory (in which case the newest
`prompts-*.jsonl` file in it is used). Defaults to `~/.claws/prompt-captures/`.

This is a standalone research tool — it is not part of the Node.js service,
its build, or its CI. Nothing here is wired into the live agent request path.
"""
import argparse
import glob
import json
import os
import statistics
import sys

DEFAULT_CAPTURE_DIR = os.path.expanduser("~/.claws/prompt-captures/")


def resolve_capture_file(path: str) -> str:
    if os.path.isdir(path):
        candidates = sorted(glob.glob(os.path.join(path, "prompts-*.jsonl")))
        if not candidates:
            print(f"No prompts-*.jsonl files found in {path}", file=sys.stderr)
            sys.exit(1)
        return candidates[-1]
    return path


def load_records(path: str, label: str | None) -> list[dict]:
    records = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if label and record.get("label") != label:
                continue
            records.append(record)
    return records


def print_stats(records: list[dict]) -> None:
    by_label: dict[str, list[dict]] = {}
    for record in records:
        by_label.setdefault(record.get("label", "unlabeled"), []).append(record)

    for label, group in sorted(by_label.items()):
        lengths = [len(r.get("prompt", "")) for r in group]
        failures = sum(1 for r in group if r.get("ok") is False)
        print(f"## {label}")
        print(f"  count:       {len(group)}")
        print(f"  mean chars:  {statistics.mean(lengths):.0f}")
        print(f"  median chars:{statistics.median(lengths):.0f}")
        print(f"  min chars:   {min(lengths)}")
        print(f"  max chars:   {max(lengths)}")
        print(f"  failures:    {failures}")
        print()


def run_optimize_example(records: list[dict], label: str) -> None:
    """Illustrative-only DSPy optimization example — NOT production code.

    Requires ANTHROPIC_API_KEY and defines a Signature that mirrors one agent
    task (issue -> plan), builds a trainset from captured prompt/output pairs
    for the chosen label, and runs BootstrapFewShot against a simple metric.
    """
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("--optimize requires ANTHROPIC_API_KEY to be set.", file=sys.stderr)
        sys.exit(1)

    import dspy  # imported lazily — only needed for --optimize

    # Model IDs: Sonnet 5 = "claude-sonnet-5", Opus 4.8 = "claude-opus-4-8".
    # DSPy's LiteLLM backend needs the "anthropic/" provider prefix.
    lm = dspy.LM("anthropic/claude-sonnet-5")
    dspy.configure(lm=lm)

    class IssueToPlan(dspy.Signature):
        """Turn a GitHub issue into an implementation plan."""

        issue: str = dspy.InputField()
        plan: str = dspy.OutputField()

    program = dspy.ChainOfThought(IssueToPlan)

    trainset = [
        dspy.Example(issue=r["prompt"], plan=r["output"]).with_inputs("issue")
        for r in records
        if r.get("label") == label and r.get("ok") and r.get("output")
    ]
    if not trainset:
        print(f"No usable (ok, non-empty output) examples found for label '{label}'.", file=sys.stderr)
        sys.exit(1)

    def metric(example, prediction, trace=None) -> bool:
        # Minimal example metric: the plan is non-empty and looks structured.
        return bool(prediction.plan) and "#" in prediction.plan

    optimizer = dspy.BootstrapFewShot(metric=metric)
    compiled = optimizer.compile(program, trainset=trainset)

    print("Optimized prompt / demos:")
    print(compiled.dump_state())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default=DEFAULT_CAPTURE_DIR)
    parser.add_argument("--label", default=None, help="Only include records with this label")
    parser.add_argument("--optimize", action="store_true", help="Run the optional DSPy optimization example")
    args = parser.parse_args()

    capture_file = resolve_capture_file(args.path)
    records = load_records(capture_file, args.label)
    if not records:
        print(f"No matching records found in {capture_file}", file=sys.stderr)
        sys.exit(1)

    print(f"Loaded {len(records)} records from {capture_file}\n")
    print_stats(records)

    if args.optimize:
        if not args.label:
            print("--optimize requires --label to select a single agent's prompts.", file=sys.stderr)
            sys.exit(1)
        run_optimize_example(records, args.label)


if __name__ == "__main__":
    main()
