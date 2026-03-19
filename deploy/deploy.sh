#!/usr/bin/env bash
set -euo pipefail

REPO="St-John-Software/claws"
INSTALL_DIR="/opt/claws"
VERSION_FILE="$INSTALL_DIR/.current-version"
STAGING_DIR="$INSTALL_DIR/staging"
SKIP_FILE="$INSTALL_DIR/.skipped-versions"

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

# 4. Backup current dist
rm -rf "$INSTALL_DIR/dist.prev"
if [[ -d "$INSTALL_DIR/dist" ]]; then
  cp -r "$INSTALL_DIR/dist" "$INSTALL_DIR/dist.prev"
fi

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
fi
if [[ -d "$STAGING_DIR/node_modules" ]]; then
  rm -rf "$INSTALL_DIR/node_modules"
  mv "$STAGING_DIR/node_modules" "$INSTALL_DIR/node_modules"
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
rm -rf "$INSTALL_DIR/dist.prev" "$STAGING_DIR"
log "Update to $LATEST_TAG complete"
DEPLOY_MSG="Deployed claws $LATEST_TAG"
if [[ -n "$RELEASE_BODY" ]]; then
  DEPLOY_MSG=$(printf '%s\n\n%s' "$DEPLOY_MSG" "$RELEASE_BODY")
fi
slack "$DEPLOY_MSG"
