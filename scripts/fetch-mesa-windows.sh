#!/usr/bin/env bash
# Download Mesa software OpenGL DLLs for Windows x64 agent bundles (VM/RDP without WGL).
#
# Mesa's opengl32.dll from mesa-dist-win requires companion libgallium_wgl.dll —
# shipping opengl32 alone causes STATUS_DLL_NOT_FOUND (0xC0000135) on Windows
# because the broken local DLL shadows the system OpenGL.
#
# Usage:
#   ./scripts/fetch-mesa-windows.sh [output_dir]
#
# Default output: web-nodejs/vendor/mesa-win64/
# Production cache: /opt/BetterDeskConsole/data/mesa-win64/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/web-nodejs/vendor/mesa-win64}"
ARCHIVE="$OUT_DIR/mesa.7z"
URL="${MESA_OPENGL32_URL:-https://github.com/pal1000/mesa-dist-win/releases/download/25.0.1/mesa3d-25.0.1-release-msvc.7z}"

# Required pair for a loadable software OpenGL stack.
REQUIRED_DLLS=(opengl32.dll libgallium_wgl.dll)

mkdir -p "$OUT_DIR"

need_fetch=0
for dll in "${REQUIRED_DLLS[@]}"; do
    if [ ! -f "$OUT_DIR/$dll" ]; then
        need_fetch=1
        break
    fi
done

if [ "$need_fetch" = 0 ]; then
    echo "Mesa DLLs already present in $OUT_DIR:"
    for dll in "${REQUIRED_DLLS[@]}"; do
        ls -lh "$OUT_DIR/$dll"
    done
    exit 0
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing $1"; exit 1; }; }
need curl
need 7z

echo "Downloading Mesa3D from $URL ..."
curl -fsSL -o "$ARCHIVE" "$URL"

extract_one() {
    local name="$1"
    7z e -y -o"$OUT_DIR" "$ARCHIVE" "x64/$name" >/dev/null 2>&1 \
        || 7z e -y -o"$OUT_DIR" "$ARCHIVE" "$name" >/dev/null 2>&1 \
        || true
}

for dll in "${REQUIRED_DLLS[@]}"; do
    extract_one "$dll"
done

# Drop the archive; keep only the runtime DLLs we need.
rm -f "$ARCHIVE"

missing=0
for dll in "${REQUIRED_DLLS[@]}"; do
    if [ ! -f "$OUT_DIR/$dll" ]; then
        echo "ERROR: $dll not found after extract" >&2
        missing=1
    else
        echo "OK: $OUT_DIR/$dll ($(du -h "$OUT_DIR/$dll" | cut -f1))"
    fi
done

if [ "$missing" = 1 ]; then
    echo "ERROR: incomplete Mesa set — refusing to leave a lone opengl32.dll (breaks Windows agents)" >&2
    rm -f "$OUT_DIR/opengl32.dll"
    exit 1
fi
