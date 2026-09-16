#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/claws"

log() { echo "==> $*"; }

log "Stopping and disabling services..."
sudo systemctl stop claws claws-updater.timer claws-updater.service 2>/dev/null || true
sudo systemctl disable claws claws-updater.timer claws-updater.service 2>/dev/null || true

log "Removing systemd units..."
sudo rm -f /etc/systemd/system/claws.service \
           /etc/systemd/system/claws-updater.service \
           /etc/systemd/system/claws-updater.timer
sudo systemctl daemon-reload

log "Removing $INSTALL_DIR..."
sudo rm -rf "$INSTALL_DIR"

log "Done — Claws has been uninstalled"
