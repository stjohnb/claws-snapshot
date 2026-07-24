#!/usr/bin/env bash
set -euo pipefail

REPO="St-John-Software/claws"
INSTALL_DIR="/opt/claws"
VERSION_FILE="$INSTALL_DIR/.current-version"
STAGING_DIR="$INSTALL_DIR/staging"
SKIP_FILE="$INSTALL_DIR/.skipped-versions"
UNHEALTHY_STAMP="$INSTALL_DIR/.unhealthy-alert-ts"
REMINDER_INTERVAL_SECONDS=3600

log() { echo "$(date -Iseconds) [deploy] $*"; }

# Resolve config path from the service user's home directory
CURRENT_UNIT="/etc/systemd/system/claws.service"
if [[ -f "$CURRENT_UNIT" ]]; then
  CLAWS_USER=$(grep '^User=' "$CURRENT_UNIT" | cut -d= -f2)
  CLAWS_HOME=$(getent passwd "$CLAWS_USER" | cut -d: -f6)
else
  CLAWS_HOME="$HOME"
fi
CONFIG_FILE="$CLAWS_HOME/.claws/config.json"
ENV_FILE="$CLAWS_HOME/.claws/env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

CONFIG_SLACK_WEBHOOK=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8')).slackWebhook||'')}catch{console.log('')}" 2>/dev/null || echo "")
SLACK_WEBHOOK="${CLAWS_SLACK_WEBHOOK:-$CONFIG_SLACK_WEBHOOK}"

CONFIG_PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8')).port||3000)}catch{console.log(3000)}" 2>/dev/null || echo "3000")
PORT="${PORT:-$CONFIG_PORT}"
HEALTH_URL="http://localhost:$PORT/health"

[[ -n "$SLACK_WEBHOOK" ]] || log "Warning: No Slack webhook configured (checked CLAWS_SLACK_WEBHOOK in $ENV_FILE and slackWebhook in $CONFIG_FILE)"
slack() {
  if [[ -z "$SLACK_WEBHOOK" ]]; then log "Warning: SLACK_WEBHOOK is empty, skipping notification"; return 0; fi
  local payload
  payload=$(jq -n --arg t "$1" '{"text":$t}')
  if ! curl -sf -X POST -H 'Content-Type: application/json' --data "$payload" "$SLACK_WEBHOOK" 2>&1; then
    log "Warning: Slack notification failed"
  fi
}

# Re-alert while the service stays unhealthy on a skip-listed release.
# The updater timer is the only component still running when claws itself
# is crash-looping (its own log.error -> Slack escalation cannot fire), so
# this is the sole persistent-alert path for a failed-rollback situation.
# Rate-limited to at most one Slack message per REMINDER_INTERVAL_SECONDS
# via a timestamp file; recovery clears the file so the next outage alerts
# immediately.
remind_if_unhealthy() {
  local tag="$1"
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    rm -f "$UNHEALTHY_STAMP"
    return 0
  fi
  local now last=0
  now=$(date +%s)
  if [[ -f "$UNHEALTHY_STAMP" ]]; then
    last=$(cat "$UNHEALTHY_STAMP" 2>/dev/null || echo 0)
  fi
  [[ "$last" =~ ^[0-9]+$ ]] || last=0
  if (( now - last < REMINDER_INTERVAL_SECONDS )); then
    log "Service unhealthy on skip-listed $tag; reminder suppressed (rate limit)"
    return 0
  fi
  log "Service unhealthy on skip-listed $tag; sending Slack reminder"
  slack "⚠️ claws is DOWN and stuck on skip-listed release $tag. Health check $HEALTH_URL is failing after a rolled-back deploy — manual intervention required. This reminder repeats roughly hourly until the service is healthy."
  echo "$now" > "$UNHEALTHY_STAMP"
}

# Install/refresh the local Whisper unit (docs/whatsapp-setup.md).
# Installed by default: whisperLocalUrl defaults to http://127.0.0.1:9000
# (matching src/config.ts), so the unit — and uv/uvx, which it runs under —
# is auto-installed unless the operator sets whisperLocalUrl to a
# non-localhost URL or an empty string. A unit that is already installed
# (e.g. manually) is kept in sync with the bundled copy either way. Called
# on every timer tick — before the release check, so unit changes converge
# within a minute of a release rather than waiting for the next one — and
# again after a release swaps the deploy/ files.
WHISPER_UNIT="/etc/systemd/system/whisper.service"
CONFIG_WHISPER_URL=$(node -e "try{const v=JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8')).whisperLocalUrl;console.log(v==null?'http://127.0.0.1:9000':v)}catch{console.log('http://127.0.0.1:9000')}" 2>/dev/null || echo "http://127.0.0.1:9000")
WHISPER_LOCAL_URL="${CLAWS_WHISPER_LOCAL_URL:-$CONFIG_WHISPER_URL}"
# whisper.service launches via `/usr/bin/env uv`, so uv must live somewhere
# on systemd's default PATH — install to /usr/local/bin, not root's ~/.local.
ensure_uvx() {
  command -v uv >/dev/null 2>&1 && return 0
  log "Installing uv to /usr/local/bin for whisper.service..."
  if curl -LsSf https://astral.sh/uv/install.sh \
      | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 INSTALLER_NO_MODIFY_PATH=1 sh \
      && command -v uv >/dev/null 2>&1; then
    return 0
  fi
  log "Warning: uv install failed — skipping whisper.service install (see docs/whatsapp-setup.md)"
  return 1
}
ensure_whisper_unit() {
  local src="$INSTALL_DIR/deploy/whisper.service" claws_user="${CLAWS_USER:-}"
  local is_local=false
  case "$WHISPER_LOCAL_URL" in
    http://127.0.0.1|http://127.0.0.1[:/]*|http://localhost|http://localhost[:/]*) is_local=true ;;
  esac
  [[ -f "$src" && -f "$INSTALL_DIR/deploy/whisper-server.py" && -n "$claws_user" ]] || return 0
  [[ "$is_local" == "true" || -f "$WHISPER_UNIT" ]] || return 0
  local rendered
  rendered=$(sed "s/User=brendan/User=$claws_user/;s/Group=brendan/Group=$claws_user/" "$src")
  if diff -q <(printf '%s\n' "$rendered") "$WHISPER_UNIT" >/dev/null 2>&1; then
    return 0
  fi
  if [[ ! -f "$WHISPER_UNIT" ]]; then
    ensure_uvx || return 0
  fi
  local was_installed=false
  [[ -f "$WHISPER_UNIT" ]] && was_installed=true
  log "Installing/updating whisper.service unit for $claws_user..."
  printf '%s\n' "$rendered" | tee "$WHISPER_UNIT" >/dev/null
  systemctl daemon-reload
  if [[ "$was_installed" == "true" ]]; then
    systemctl try-restart whisper || log "Warning: whisper restart returned non-zero"
  else
    systemctl enable --now whisper || log "Warning: enabling whisper returned non-zero"
  fi
}
ensure_whisper_unit

# 1. Get latest release tag
LATEST_TAG=$(sudo -u brendan gh release list -R "$REPO" --limit 1 --json tagName --jq '.[0].tagName')
if [[ -z "$LATEST_TAG" ]]; then
  log "No releases found"
  exit 0
fi

# 2. Compare with current version
CURRENT_TAG=""
if [[ -f "$VERSION_FILE" ]]; then
  CURRENT_TAG=$(cat "$VERSION_FILE")
fi

if [[ "$LATEST_TAG" == "$CURRENT_TAG" ]]; then
  log "Already up to date ($CURRENT_TAG)"
  exit 0
fi

# Check if this version was previously rolled back
if [[ -f "$SKIP_FILE" ]] && grep -qxF "$LATEST_TAG" "$SKIP_FILE"; then
  log "Skipping $LATEST_TAG (previously rolled back)"
  remind_if_unhealthy "$LATEST_TAG"
  exit 0
fi

log "Updating from $CURRENT_TAG to $LATEST_TAG"

RELEASE_BODY=$(sudo -u brendan gh release view "$LATEST_TAG" -R "$REPO" --json body --jq '.body' 2>/dev/null || echo "")

# 3. Download and extract
TMPFILE=$(sudo -u brendan mktemp /tmp/claws-XXXXXX.tar.gz)
sudo -u brendan gh release download "$LATEST_TAG" -R "$REPO" -p "claws.tar.gz" -O "$TMPFILE" --clobber
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
tar -xzf "$TMPFILE" -C "$STAGING_DIR"
rm -f "$TMPFILE"

# 3b. Verify host Node ABI compatibility BEFORE touching the running service.
# Release tarballs bundle prebuilt native modules (better-sqlite3) compiled
# against the build's Node major. A build Node newer than the host's crashes at
# startup with ERR_DLOPEN_FAILED (NODE_MODULE_VERSION mismatch). Checking here —
# before backup/stop/swap — means a mismatch aborts with the old version still
# running and healthy (no downtime). See the 2026-07-18 failed-deploy incident.
BUILD_NODE_VERSION_FILE="$STAGING_DIR/.node-version"
if [[ -f "$BUILD_NODE_VERSION_FILE" ]]; then
  BUILD_NODE_MAJOR=$(tr -dc '0-9' < "$BUILD_NODE_VERSION_FILE" | head -c 3)
  HOST_NODE_MAJOR=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
  if [[ -n "$BUILD_NODE_MAJOR" && -n "$HOST_NODE_MAJOR" && "$BUILD_NODE_MAJOR" != "$HOST_NODE_MAJOR" ]]; then
    log "ERROR: Node ABI mismatch — release $LATEST_TAG built on Node $BUILD_NODE_MAJOR, host runs Node $HOST_NODE_MAJOR. Aborting before swap; $CURRENT_TAG left running."
    slack "Deploy of claws $LATEST_TAG ABORTED: built on Node $BUILD_NODE_MAJOR but host runs Node $HOST_NODE_MAJOR (native-module ABI mismatch). Running version $CURRENT_TAG is untouched and healthy. Upgrade the host to Node $BUILD_NODE_MAJOR, then remove $LATEST_TAG from $SKIP_FILE to redeploy."
    echo "$LATEST_TAG" >> "$SKIP_FILE"
    log "Added $LATEST_TAG to skip list"
    rm -rf "$STAGING_DIR"
    exit 1
  fi
else
  log "Warning: no .node-version in release $LATEST_TAG tarball — skipping Node ABI check (pre-feature release)"
fi

# 4. Backup current dist
rm -rf "$INSTALL_DIR/dist.prev"
if [[ -d "$INSTALL_DIR/dist" ]]; then
  cp -r "$INSTALL_DIR/dist" "$INSTALL_DIR/dist.prev"
fi
rm -rf "$INSTALL_DIR/node_modules.prev"

# 5. Stop service before swapping files
log "Stopping claws service..."
systemctl stop claws || log "Warning: systemctl stop returned non-zero"

# 6. Replace dist, deploy, and node_modules with staging contents
#    Note: ~/.claws/ (config.json, env) is user-managed and never touched by deployment.
rm -rf "$INSTALL_DIR/dist"
mv "$STAGING_DIR/dist" "$INSTALL_DIR/dist"
if [[ -d "$STAGING_DIR/deploy" ]]; then
  rm -rf "$INSTALL_DIR/deploy"
  mv "$STAGING_DIR/deploy" "$INSTALL_DIR/deploy"
  chmod +x "$INSTALL_DIR/deploy/deploy.sh"
  chmod +x "$INSTALL_DIR/deploy/install-skills.sh"
fi
if [[ -d "$STAGING_DIR/node_modules" ]]; then
  if [[ -d "$INSTALL_DIR/node_modules" ]]; then
    mv "$INSTALL_DIR/node_modules" "$INSTALL_DIR/node_modules.prev"
  fi
  mv "$STAGING_DIR/node_modules" "$INSTALL_DIR/node_modules"
fi

if [[ -x "$INSTALL_DIR/deploy/install-skills.sh" ]]; then
  log "Installing Claude skills for ${CLAWS_USER:-$USER}..."
  "$INSTALL_DIR/deploy/install-skills.sh" "$CLAWS_HOME" "${CLAWS_USER:-}" \
    || log "Warning: skill install returned non-zero"
fi

# 7. Reinstall systemd units (preserve User/Group/PATH from installed unit)
CURRENT_UNIT="/etc/systemd/system/claws.service"
if [[ -f "$CURRENT_UNIT" ]]; then
  CLAWS_USER=$(grep '^User=' "$CURRENT_UNIT" | cut -d= -f2)
  CLAWS_PATH=$(grep '^Environment=PATH=' "$CURRENT_UNIT" | sed 's/^Environment=PATH=//')
  log "Reinstalling systemd units for $CLAWS_USER..."
  sed "s/User=brendan/User=$CLAWS_USER/;s/Group=brendan/Group=$CLAWS_USER/;s|/home/brendan/|$CLAWS_HOME/|" \
    "$INSTALL_DIR/deploy/claws.service" | \
    sed "/\[Service\]/a Environment=PATH=$CLAWS_PATH" | \
    tee /etc/systemd/system/claws.service >/dev/null
  cp "$INSTALL_DIR/deploy/claws-updater.service" /etc/systemd/system/
  cp "$INSTALL_DIR/deploy/claws-updater.timer" /etc/systemd/system/
  systemctl daemon-reload
  ensure_whisper_unit
fi

# 8. Start service
log "Starting claws service..."
systemctl start claws || log "Warning: systemctl start returned non-zero"

# 9. Health check (poll for up to 45s)
healthy=false
for i in $(seq 1 45); do
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 1
done

# 10. Rollback if unhealthy
if [[ "$healthy" != "true" ]]; then
  log "Health check failed after update — rolling back"

  if [[ -d "$INSTALL_DIR/dist.prev" ]]; then
    rm -rf "$INSTALL_DIR/dist"
    mv "$INSTALL_DIR/dist.prev" "$INSTALL_DIR/dist"
    if [[ -d "$INSTALL_DIR/node_modules.prev" ]]; then
      rm -rf "$INSTALL_DIR/node_modules"
      mv "$INSTALL_DIR/node_modules.prev" "$INSTALL_DIR/node_modules"
    fi
    systemctl restart claws || log "Warning: rollback restart returned non-zero"

    rollback_healthy=false
    for i in $(seq 1 30); do
      if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
        rollback_healthy=true
        break
      fi
      sleep 1
    done

    if [[ "$rollback_healthy" == "true" ]]; then
      log "Rollback successful"
      slack "Deploy of claws $LATEST_TAG failed — rolled back to $CURRENT_TAG"
      echo "$LATEST_TAG" >> "$SKIP_FILE"
      log "Added $LATEST_TAG to skip list"
      exit 1
    else
      log "ERROR: Rollback also failed — manual intervention required"
      slack "Deploy of claws $LATEST_TAG failed — rollback also failed, manual intervention required"
      echo "$LATEST_TAG" >> "$SKIP_FILE"
      log "Added $LATEST_TAG to skip list"
      exit 1
    fi
  else
    log "ERROR: No previous version to rollback to"
    slack "Deploy of claws $LATEST_TAG failed — no previous version to rollback to"
    echo "$LATEST_TAG" >> "$SKIP_FILE"
    log "Added $LATEST_TAG to skip list"
    exit 1
  fi
fi

# 11. Success — record version and clean up
echo "$LATEST_TAG" > "$VERSION_FILE"
rm -rf "$INSTALL_DIR/dist.prev" "$INSTALL_DIR/node_modules.prev" "$STAGING_DIR"
rm -f "$UNHEALTHY_STAMP"
log "Update to $LATEST_TAG complete"
DEPLOY_MSG="Deployed claws $LATEST_TAG"
if [[ -n "$RELEASE_BODY" ]]; then
  DEPLOY_MSG=$(printf '%s\n\n%s' "$DEPLOY_MSG" "$RELEASE_BODY")
fi
slack "$DEPLOY_MSG"
