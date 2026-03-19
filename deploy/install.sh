#!/usr/bin/env bash
set -euo pipefail

REPO="St-John-Software/claws"
INSTALL_DIR="/opt/claws"
USER_NAME="$(whoami)"

log() { echo "==> $*"; }

# Must have gh CLI available
if ! command -v gh &>/dev/null; then
  echo "Error: gh CLI is required. Install it from https://cli.github.com" >&2
  exit 1
fi

# Create install directory
log "Creating $INSTALL_DIR (owned by $USER_NAME)"
sudo mkdir -p "$INSTALL_DIR"
sudo chown "$USER_NAME":"$USER_NAME" "$INSTALL_DIR"

# Download and extract latest release
log "Downloading latest release..."
LATEST_TAG=$(gh release list -R "$REPO" --limit 1 --json tagName --jq '.[0].tagName')
TMPFILE=$(mktemp /tmp/claws-XXXXXX.tar.gz)
gh release download -R "$REPO" --pattern 'claws.tar.gz' -O "$TMPFILE" --clobber
tar -xzf "$TMPFILE" -C "$INSTALL_DIR"
rm -f "$TMPFILE"
echo "$LATEST_TAG" > "$INSTALL_DIR/.current-version"

# Patch the service unit with the current user and PATH
log "Installing systemd units for user $USER_NAME..."
sed "s/User=brendan/User=$USER_NAME/;s/Group=brendan/Group=$USER_NAME/;s|/home/brendan/|/home/$USER_NAME/|" \
  "$INSTALL_DIR/deploy/claws.service" | \
  sed "/\[Service\]/a Environment=PATH=$PATH" | \
  sudo tee /etc/systemd/system/claws.service >/dev/null
sudo cp "$INSTALL_DIR/deploy/claws-updater.service" /etc/systemd/system/
sudo cp "$INSTALL_DIR/deploy/claws-updater.timer" /etc/systemd/system/
chmod +x "$INSTALL_DIR/deploy/deploy.sh"

# Bootstrap config file if it doesn't exist
CONFIG_DIR="$HOME/.claws"
CONFIG_FILE="$CONFIG_DIR/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_FILE" << 'CONF'
{
  "slackWebhook": "",
  "githubOwners": ["stjohnb", "St-John-Software"],
  "selfRepo": "St-John-Software/claws",
  "kwyjiboBaseUrl": "https://kwyjibo.vercel.app",
  "kwyjiboApiKey": ""
}
CONF
  chmod 600 "$CONFIG_FILE"
  log "Created $CONFIG_FILE — edit it to set your Slack webhook URL"
fi

# Bootstrap env file if it doesn't exist (never overwrite user values)
ENV_FILE="$CONFIG_DIR/env"
if [[ ! -f "$ENV_FILE" ]]; then
  mkdir -p "$CONFIG_DIR"
  cat > "$ENV_FILE" << 'CONF'
# Environment variables loaded by the claws systemd unit.
# Uncomment and set values as needed.
# CLAWS_SLACK_WEBHOOK=https://hooks.slack.com/services/T.../B.../xxx
# KWYJIBO_BASE_URL=https://kwyjibo.vercel.app
# KWYJIBO_AUTOMATION_API_KEY=
CONF
  chmod 600 "$ENV_FILE"
  log "Created $ENV_FILE — edit it to set environment overrides"
fi

# Enable and start
log "Enabling and starting services..."
sudo systemctl daemon-reload
sudo systemctl enable --now claws
sudo systemctl enable --now claws-updater.timer

log "Done! Claws is running as $USER_NAME"
log "  Status:  sudo systemctl status claws"
log "  Logs:    journalctl -u claws -f"
