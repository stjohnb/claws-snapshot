#!/usr/bin/env bash
# Integration test: verifies opencode invocation matches what claws does in production.
# Run: bash scripts/test-opencode-integration.sh
set -euo pipefail

PASS=0
FAIL=0
TESTS=()

pass() { PASS=$((PASS + 1)); TESTS+=("PASS: $1"); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); TESTS+=("FAIL: $1 — $2"); echo "  FAIL: $1 — $2"; }

echo "=== OpenCode Integration Tests ==="
echo ""

# 1. Verify opencode is on PATH
echo "[1/6] opencode binary discoverable..."
if command -v opencode &>/dev/null; then
  pass "opencode found at $(command -v opencode)"
else
  fail "opencode not on PATH" "install opencode or add ~/.opencode/bin to PATH"
  echo "FATAL: cannot continue without opencode"
  exit 1
fi

# 2. Verify OpenRouter provider is configured
echo "[2/6] OpenRouter provider configured..."
AUTH_OUTPUT=$(opencode auth list 2>&1)
if echo "$AUTH_OUTPUT" | grep -qi "openrouter"; then
  pass "OpenRouter credentials found"
else
  fail "OpenRouter not in auth list" "$AUTH_OUTPUT"
fi

# 3. Test sonnet model (adequate tier) via stdin — exactly how claws invokes it
echo "[3/6] opencode run --model openrouter/anthropic/claude-sonnet-4.5 (stdin prompt)..."
SONNET_OUT=$(echo "Reply with exactly one word: SONNET_OK" | opencode run --model openrouter/anthropic/claude-sonnet-4.5 2>&1) || true
if echo "$SONNET_OUT" | grep -q "SONNET_OK"; then
  pass "sonnet model responded correctly"
else
  fail "sonnet model failed" "$(echo "$SONNET_OUT" | head -5)"
fi

# 4. Test opus model (best tier)
echo "[4/6] opencode run --model openrouter/anthropic/claude-opus-4 (stdin prompt)..."
OPUS_OUT=$(echo "Reply with exactly one word: OPUS_OK" | opencode run --model openrouter/anthropic/claude-opus-4 2>&1) || true
if echo "$OPUS_OUT" | grep -q "OPUS_OK"; then
  pass "opus model responded correctly"
else
  fail "opus model failed" "$(echo "$OPUS_OUT" | head -5)"
fi

# 5. Test cheap model (gemini flash)
echo "[5/6] opencode run --model openrouter/google/gemini-2.5-flash (stdin prompt)..."
CHEAP_OUT=$(echo "Reply with exactly one word: CHEAP_OK" | opencode run --model openrouter/google/gemini-2.5-flash 2>&1) || true
if echo "$CHEAP_OUT" | grep -q "CHEAP_OK"; then
  pass "cheap model responded correctly"
else
  fail "cheap model failed" "$(echo "$CHEAP_OUT" | head -5)"
fi

# 6. Test with a realistic multi-line issue-planning prompt (the kind that broke yargs)
echo "[6/6] realistic multi-line prompt with markdown, dashes, code fences..."
PLAN_PROMPT='You are an issue planner. Given the following issue, respond with exactly: PLAN_OK

## Issue: Fix CI pipeline

The `--deploy` flag in `scripts/deploy.sh` is broken.

```bash
./scripts/deploy.sh --deploy --env production
```

Steps to reproduce:
- Run the command above
- Observe error on line 42
- The `grep -E "pattern|other"` call fails

Do NOT write any code. Just respond with: PLAN_OK'

PLAN_OUT=$(echo "$PLAN_PROMPT" | opencode run --model openrouter/anthropic/claude-sonnet-4.5 2>&1) || true
if echo "$PLAN_OUT" | grep -q "PLAN_OK"; then
  pass "multi-line prompt with special chars handled correctly"
else
  fail "multi-line prompt failed" "$(echo "$PLAN_OUT" | head -5)"
fi

# Summary
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
for t in "${TESTS[@]}"; do echo "  $t"; done

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
