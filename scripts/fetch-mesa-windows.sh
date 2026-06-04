#!/usr/bin/env bash
# Download Mesa software opengl32.dll for Windows x64 agent bundles (VM/RDP without WGL).
#
# Usage:
#   ./scripts/fetch-mesa-windows.sh [output_dir]
#
# Default output: web-nodejs/vendor/mesa-win64/opengl32.dll
# Production cache: /opt/BetterDeskConsole/data/mesa-win64/opengl32.dll
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/web-nodejs/vendor/mesa-win64}"
ARCHIVE="$OUT_DIR/mesa.7z"
URL="${MESA_OPENGL32_URL:-https://github.com/pal1000/mesa-dist-win/releases/download/25.0.1/mesa3d-25.0.1-release-msvc.7z}"

mkdir -p "$OUT_DIR"
if [ -f "$OUT_DIR/opengl32.dll" ]; then
    echo "Mesa DLL already present: $OUT_DIR/opengl32.dll"
    exit 0
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing $1"; exit 1; }; }
need curl
need 7z

echo "Downloading Mesa3D from $URL ..."
curl -fsSL -o "$ARCHIVE" "$URL"
7z e -y -o"$OUT_DIR" "$ARCHIVE" x64/opengl32.dll >/dev/null 2>&1 \
    || 7z e -y -o"$OUT_DIR" "$ARCHIVE" opengl32.dll >/dev/null
rm -f "$ARCHIVE"

if [ ! -f "$OUT_DIR/opengl32.dll" ]; then
    echo "ERROR: opengl32.dll not found after extract" >&2
    exit 1
fi
echo "OK: $OUT_DIR/opengl32.dll ($(du -h "$OUT_DIR/opengl32.dll" | cut -f1))"
