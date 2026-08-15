#!/usr/bin/env bash
# BetterDesk Agent — Linux installer (systemd)
# Usage: sudo ./install.sh [OPTIONS]
#   -s URL        Gateway WebSocket URL
#   -k KEY        API key
#   -n NAME       Device name
#   -d DIR        Install directory (default: /opt/betterdesk-agent)
#   -u            Uninstall
#   -p, --purge   With -u, also remove config, data and service user
set -euo pipefail

INSTALL_DIR="/opt/betterdesk-agent"
SERVICE_NAME="betterdesk-agent"
USER_NAME="betterdesk-agent"
CONFIG_FILE=""
SERVER_URL=""
API_KEY=""
DEVICE_NAME=""
UNINSTALL=false
PURGE=false

# Accept the long purge flag while retaining POSIX getopts for the existing
# short options.
filtered_args=()
for arg in "$@"; do
    if [ "$arg" = "--purge" ]; then
        PURGE=true
    else
        filtered_args+=("$arg")
    fi
done
set -- "${filtered_args[@]}"

usage() {
    echo "Usage: sudo $0 [-s URL] [-k KEY] [-n NAME] [-d DIR] [-u] [-p|--purge]"
    echo "  -s URL   Gateway WebSocket URL (ws://host:21122/cdap)"
    echo "  -k KEY   API key for authentication"
    echo "  -n NAME  Device name (default: hostname)"
    echo "  -d DIR   Install directory (default: /opt/betterdesk-agent)"
    echo "  -u       Uninstall (preserves config and data)"
    echo "  -p       With -u, remove config, data and service user"
    exit 1
}

while getopts "s:k:n:d:uph" opt; do
    case $opt in
        s) SERVER_URL="$OPTARG" ;;
        k) API_KEY="$OPTARG" ;;
        n) DEVICE_NAME="$OPTARG" ;;
        d) INSTALL_DIR="$OPTARG" ;;
        u) UNINSTALL=true ;;
        p) PURGE=true ;;
        h|*) usage ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: This script must be run as root (sudo)"
    exit 1
fi

uninstall() {
    echo "=== Uninstalling BetterDesk Agent ==="
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
    if id "$USER_NAME" &>/dev/null; then
        userdel "$USER_NAME" 2>/dev/null || true
    fi
    if $PURGE; then
        rm -rf "$INSTALL_DIR"
        if id "$USER_NAME" &>/dev/null; then
            userdel "$USER_NAME" 2>/dev/null || true
        fi
        echo "BetterDesk Agent uninstalled and data purged."
    else
        rm -f "${INSTALL_DIR}/betterdesk-agent"
        echo "BetterDesk Agent uninstalled; config and data preserved at ${INSTALL_DIR}."
    fi
    exit 0
}

if $UNINSTALL; then
    uninstall
fi

# Detect binary
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY=""
if [ -f "${SCRIPT_DIR}/../betterdesk-agent-linux-amd64" ] && [ "$(uname -m)" = "x86_64" ]; then
    BINARY="${SCRIPT_DIR}/../betterdesk-agent-linux-amd64"
elif [ -f "${SCRIPT_DIR}/../betterdesk-agent" ]; then
    BINARY="${SCRIPT_DIR}/../betterdesk-agent"
else
    echo "ERROR: Agent binary not found. Build it first: go build -o betterdesk-agent ."
    exit 1
fi

echo "=== Installing BetterDesk Agent ==="

# Create service user
if ! id "$USER_NAME" &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
    echo "Created service user: $USER_NAME"
fi

# Install binary
mkdir -p "$INSTALL_DIR"
cp "$BINARY" "${INSTALL_DIR}/betterdesk-agent"
chmod 755 "${INSTALL_DIR}/betterdesk-agent"

# Create data directory
mkdir -p "${INSTALL_DIR}/data"
chown -R "$USER_NAME:$USER_NAME" "${INSTALL_DIR}/data"

# Create config if not exists
CONFIG_FILE="${INSTALL_DIR}/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
    if [ -z "$SERVER_URL" ]; then
        read -rp "Gateway WebSocket URL (ws://host:21122/cdap): " SERVER_URL
    fi
    if [ -z "$API_KEY" ]; then
        read -rp "API Key: " API_KEY
    fi
    if [ -z "$DEVICE_NAME" ]; then
        DEVICE_NAME="$(hostname)"
    fi
    case "$SERVER_URL" in
        ws://*|wss://*) ;;
        *) echo "ERROR: Gateway URL must start with ws:// or wss://"; exit 1 ;;
    esac
    if [ -z "$API_KEY" ]; then
        echo "ERROR: API key must not be empty"; exit 1
    fi
    if ! command -v python3 >/dev/null 2>&1; then
        echo "ERROR: python3 is required to safely create config.json"; exit 1
    fi
    BD_SERVER_URL="$SERVER_URL" \
        BD_API_KEY="$API_KEY" \
        BD_DEVICE_NAME="$DEVICE_NAME" \
        BD_INSTALL_DIR="$INSTALL_DIR" \
        python3 - "$CONFIG_FILE" <<'PY'
import json
import os
import sys

config_path = sys.argv[1]
config = {
    "server": os.environ["BD_SERVER_URL"],
    "auth_method": "api_key",
    "api_key": os.environ["BD_API_KEY"],
    "device_name": os.environ["BD_DEVICE_NAME"],
    "device_type": "os_agent",
    "terminal": True,
    "file_browser": True,
    "clipboard": True,
    "screenshot": True,
    "file_root": "/",
    "heartbeat_sec": 15,
    "reconnect_sec": 5,
    "max_reconnect": 300,
    "log_level": "info",
    "data_dir": os.path.join(os.environ["BD_INSTALL_DIR"], "data"),
}
with open(config_path, "w", encoding="utf-8") as handle:
    json.dump(config, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
os.chmod(config_path, 0o600)
PY
    chown "$USER_NAME:$USER_NAME" "$CONFIG_FILE"
    echo "Config created: $CONFIG_FILE"
else
    echo "Config exists, preserving: $CONFIG_FILE"
fi

# Create systemd service
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=BetterDesk CDAP Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER_NAME}
Group=${USER_NAME}
ExecStart=${INSTALL_DIR}/betterdesk-agent -config ${CONFIG_FILE}
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${INSTALL_DIR}/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl start "$SERVICE_NAME"
if ! systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "ERROR: BetterDesk Agent service failed to start"
    systemctl status "$SERVICE_NAME" --no-pager || true
    exit 1
fi

echo ""
echo "=== BetterDesk Agent Installed ==="
echo "  Binary:  ${INSTALL_DIR}/betterdesk-agent"
echo "  Config:  ${CONFIG_FILE}"
echo "  Service: ${SERVICE_NAME}"
echo ""
echo "Commands:"
echo "  systemctl status  $SERVICE_NAME"
echo "  journalctl -u $SERVICE_NAME -f"
echo "  systemctl restart $SERVICE_NAME"
