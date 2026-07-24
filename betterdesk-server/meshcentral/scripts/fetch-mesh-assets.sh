#!/usr/bin/env bash
# BetterDesk mesh assets are authored in-repo (AGPL). No upstream fetch required.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../assets" && pwd)"
echo "BetterDesk mesh assets live in: $ROOT"
echo "  - bettercore.js (BetterCore — embedded in betterdesk-server)"
echo "  - betterviewer.js (BetterViewer — panel: web-nodejs/public/js/rdclient/)"
ls -la "$ROOT/bettercore.js" 2>/dev/null || true
