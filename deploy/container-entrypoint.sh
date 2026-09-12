#!/usr/bin/env bash
# Container entrypoint. Only $HOME/.claws (the PVC) persists. Every provider home
# is rebuilt here from explicit config: no volume, no hidden state. Claude agent
# memories are NOT restored — they are pushed to the claude-memories branch and
# folded into docs/ from there. Never chown: we are uid 1000 and an EPERM under
# `set -e` crash-loops the pod.
set -euo pipefail

mkdir -p "$HOME/.claws" "$HOME/.claude" "$HOME/.codex"

if [ -n "${CLAWS_SSH_PRIVATE_KEY:-}" ]; then
  mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
  printf '%s\n' "$CLAWS_SSH_PRIVATE_KEY" > "$HOME/.ssh/id_ed25519"
  chmod 600 "$HOME/.ssh/id_ed25519"
fi
if [ -n "${CLAWS_KUBECONFIG:-}" ]; then
  mkdir -p "$HOME/.kube"
  printf '%s\n' "$CLAWS_KUBECONFIG" > "$HOME/.kube/config"
  chmod 600 "$HOME/.kube/config"
fi
if [ -n "${CLAWS_CODEX_AUTH_JSON:-}" ]; then
  printf '%s\n' "$CLAWS_CODEX_AUTH_JSON" > "$HOME/.codex/auth.json"
  chmod 600 "$HOME/.codex/auth.json"
fi
if [ -n "${CLAWS_CLAUDE_SETTINGS_JSON:-}" ]; then
  printf '%s\n' "$CLAWS_CLAUDE_SETTINGS_JSON" > "$HOME/.claude/settings.json"
  chmod 600 "$HOME/.claude/settings.json"
fi

# The four secrets above are now on disk; drop them from the environment so
# they are not inherited by the service, by any agent CLI child, or by the
# lifecycle scripts an agent's `npm install` runs on a third-party PR branch.
# `sanitiseEnvForChild`/`buildCapabilityEnvArgs` strip them too (defence in
# depth) — nothing in src/ ever reads these vars, only ~/.ssh, ~/.kube,
# ~/.codex, ~/.claude written above.
unset CLAWS_SSH_PRIVATE_KEY CLAWS_KUBECONFIG CLAWS_CODEX_AUTH_JSON CLAWS_CLAUDE_SETTINGS_JSON

# Refresh bundled skills into ~/.claude/skills and ~/.codex/skills — the same
# thing deploy.sh does on the systemd host. Idempotent; skills live in the image.
if [ -d /opt/claws/deploy/skills ]; then
  /opt/claws/deploy/install-skills.sh "$HOME" claws
fi

exec node /opt/claws/dist/main.js "$@"
