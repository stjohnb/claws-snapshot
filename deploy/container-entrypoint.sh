#!/usr/bin/env bash
# Container entrypoint. Only $HOME/.claws (the PVC) persists. Every provider home
# is rebuilt here from explicit config: no volume, no hidden state. Claude agent
# memories are NOT restored — they are pushed to the claude-memories branch and
# folded into docs/ from there. Never chown: we are uid 1000 and an EPERM under
# `set -e` crash-loops the pod.
set -euo pipefail

mkdir -p "$HOME/.claws" "$HOME/.claude" "$HOME/.codex"

seed_skel_dir() {
  local src="$1"
  local dest="$2"
  [ -d "$src" ] || return 0
  if [ -L "$dest" ] || { [ -e "$dest" ] && [ ! -d "$dest" ]; }; then
    return 0
  fi
  mkdir -p "$dest"
  local entry base target
  for entry in "$src"/.[!.]* "$src"/..?* "$src"/*; do
    [ -e "$entry" ] || continue
    base="$(basename "$entry")"
    target="$dest/$base"
    if [ -d "$entry" ] && [ ! -L "$entry" ]; then
      seed_skel_dir "$entry" "$target"
    elif [ ! -e "$target" ] && [ ! -L "$target" ]; then
      cp -a "$entry" "$target"
    fi
  done
}

# A PVC hides the image's /home/claws. Seed shared session defaults from
# nixos-config only when absent, preserving edits across pod restarts.
seed_skel_dir /etc/skel "$HOME"

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
if [ -n "${CLAWS_PROD_KUBECONFIG:-}" ]; then
  mkdir -p "$HOME/.kube"
  printf '%s\n' "$CLAWS_PROD_KUBECONFIG" > "$HOME/.kube/prod-config"
  chmod 600 "$HOME/.kube/prod-config"
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
unset CLAWS_SSH_PRIVATE_KEY CLAWS_KUBECONFIG CLAWS_PROD_KUBECONFIG CLAWS_CODEX_AUTH_JSON CLAWS_CLAUDE_SETTINGS_JSON

# Refresh bundled skills into ~/.claude/skills and ~/.codex/skills.
# Idempotent; skills live in the image.
if [ -d /opt/claws/deploy/skills ]; then
  /opt/claws/deploy/install-skills.sh "$HOME" claws
fi

# A headless agent pod (CLAWS_WORK_BACKEND=k8s-pod) runs one work-queue row
# instead of the service, on the HOME rebuilt above.
if [ -n "${CLAWS_AGENT_POD_ROW:-}" ]; then
  exec node /opt/claws/dist/agent-pod/main.js
fi

exec node /opt/claws/dist/main.js "$@"
