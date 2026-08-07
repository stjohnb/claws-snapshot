#!/usr/bin/env bash
# Installs the Claude Code skills bundled with this repo into a user's
# ~/.claude/skills/. Called by deploy.sh on every release and by install.sh
# on first install; also runnable directly from a repo checkout.
#
# Usage: install-skills.sh [target-home] [target-user]
set -euo pipefail

TARGET_HOME="${1:-$HOME}"
TARGET_USER="${2:-$(whoami)}"

log() { echo "$(date -Iseconds) [install-skills] $*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Tarball layout ships skills at deploy/skills (see release.yml); a plain
# repo checkout has them at .claude/skills instead.
if [[ -d "$SCRIPT_DIR/skills" ]]; then
  SRC_DIR="$SCRIPT_DIR/skills"
elif [[ -d "$SCRIPT_DIR/../.claude/skills" ]]; then
  SRC_DIR="$SCRIPT_DIR/../.claude/skills"
else
  log "No skills source found — nothing to install"
  exit 0
fi

DEST_DIR="$TARGET_HOME/.claude/skills"
mkdir -p "$DEST_DIR"

for d in "$SRC_DIR"/*/; do
  [[ -d "$d" ]] || continue
  name="$(basename "$d")"
  rm -rf "${DEST_DIR:?}/$name"
  cp -r "$d" "$DEST_DIR/$name"
  log "Installed skill: $name"
done

if [[ "$EUID" -eq 0 && -n "$TARGET_USER" ]]; then
  chown -R "$TARGET_USER:$TARGET_USER" "$DEST_DIR"
fi
