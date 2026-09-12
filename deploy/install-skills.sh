#!/usr/bin/env bash
# Installs the bundled repo-local skills into both provider homes:
# ~/.claude/skills/ and ${CODEX_HOME:-~/.codex}/skills. Called by deploy.sh on
# every release and by install.sh on first install; also runnable directly from
# a repo checkout.
#
# Usage: install-skills.sh [target-home] [target-user]
set -euo pipefail

TARGET_HOME="${1:-$HOME}"
TARGET_USER="${2:-$(whoami)}"

log() { echo "$(date -Iseconds) [install-skills] $*"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Tarball layout ships skills at deploy/skills (see release.yml); a plain
# repo checkout prefers .skills and falls back to legacy .claude/skills.
if [[ -d "$SCRIPT_DIR/skills" ]]; then
  SRC_DIR="$SCRIPT_DIR/skills"
elif [[ -d "$SCRIPT_DIR/../.skills" ]]; then
  SRC_DIR="$SCRIPT_DIR/../.skills"
elif [[ -d "$SCRIPT_DIR/../.claude/skills" ]]; then
  SRC_DIR="$SCRIPT_DIR/../.claude/skills"
else
  log "No skills source found — nothing to install"
  exit 0
fi

CLAUDE_DEST_DIR="$TARGET_HOME/.claude/skills"
CODEX_HOME="${CODEX_HOME:-$TARGET_HOME/.codex}"
CODEX_DEST_DIR="$CODEX_HOME/skills"
mkdir -p "$CLAUDE_DEST_DIR" "$CODEX_DEST_DIR"

for d in "$SRC_DIR"/*/; do
  [[ -d "$d" ]] || continue
  name="$(basename "$d")"
  rm -rf "${CLAUDE_DEST_DIR:?}/$name" "${CODEX_DEST_DIR:?}/$name"
  cp -r "$d" "$CLAUDE_DEST_DIR/$name"
  cp -r "$d" "$CODEX_DEST_DIR/$name"
  log "Installed skill: $name to $CLAUDE_DEST_DIR and $CODEX_DEST_DIR"
done

if [[ "$EUID" -eq 0 && -n "$TARGET_USER" ]]; then
  chown -R "$TARGET_USER:$TARGET_USER" "$CLAUDE_DEST_DIR" "$CODEX_DEST_DIR"
fi
