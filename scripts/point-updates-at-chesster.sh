#!/usr/bin/env bash
# One-time: point BetterDesk console Updates at Chesster1981/BetterDesk (dev).
# Run on the panel host as root (or a user that can edit the console .env and restart services).
#
# Usage:
#   sudo bash scripts/point-updates-at-chesster.sh
#   sudo bash scripts/point-updates-at-chesster.sh /opt/BetterDeskConsole/.env

set -euo pipefail

upsert_env_key() {
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    sed -i.bak -E "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

ENV_PATH="${1:-}"
if [[ -z "$ENV_PATH" ]]; then
  for cand in \
    /opt/BetterDeskConsole/.env \
    /opt/betterdesk/web-nodejs/.env \
    /opt/BetterDesk/web-nodejs/.env \
    /opt/betterdesk/console/.env
  do
    if [[ -f "$cand" ]]; then
      ENV_PATH="$cand"
      break
    fi
  done
fi

if [[ -z "$ENV_PATH" || ! -f "$ENV_PATH" ]]; then
  echo "Console .env not found. Pass the path: $0 /path/to/web-nodejs/.env" >&2
  exit 1
fi

echo "Using $ENV_PATH"
upsert_env_key "$ENV_PATH" UPDATE_GITHUB_OWNER Chesster1981
upsert_env_key "$ENV_PATH" UPDATE_GITHUB_REPO BetterDesk
upsert_env_key "$ENV_PATH" UPDATE_GITHUB_BRANCH dev

echo "Set UPDATE_GITHUB_OWNER=Chesster1981, REPO=BetterDesk, BRANCH=dev"
echo "Restart the console, then Settings → Updates → Check / Install (include Go server)."

if command -v systemctl >/dev/null 2>&1; then
  for svc in betterdesk-console BetterDeskConsole betterdesk-server; do
    if systemctl list-unit-files "$svc.service" >/dev/null 2>&1; then
      systemctl restart "$svc" && echo "Restarted $svc"
    fi
  done
fi
