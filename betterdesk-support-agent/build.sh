#!/usr/bin/env bash
# BetterDesk Support Agent — build helper.
#
# Produces the single self-contained binary that serves BOTH distribution
# forms (installer + portable). The Console "Generator agenta" calls this with
# a branding profile to bake per-deployment connection details and appearance.
#
# Usage:
#   ./build.sh [-b branding.json] [-o output] [-p linux|windows|darwin] [-d]
#
#   -d        Linux only: build X11 + Wayland binaries and a session-aware launcher.
#
#   -b FILE   Branding profile copied to resources/branding.json before build
#             (default: keep the checked-in unbranded profile)
#   -o FILE   Output binary path (default: dist/betterdesk-support[-os])
#   -p OS     Target OS (default: host OS). Cross-compiling Fyne needs the
#             matching CGO toolchain (mingw-w64 for windows, osxcross for darwin).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BRANDING=""
OUTPUT=""
TARGET_OS=""
DUAL_LINUX=0

while getopts "b:o:p:dh" opt; do
    case $opt in
        b) BRANDING="$OPTARG" ;;
        o) OUTPUT="$OPTARG" ;;
        p) TARGET_OS="$OPTARG" ;;
        d) DUAL_LINUX=1 ;;
        h) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) exit 1 ;;
    esac
done

GO="${GO_BIN:-go}"
if [ -z "$TARGET_OS" ]; then
    TARGET_OS="$($GO env GOOS 2>/dev/null || uname -s | tr '[:upper:]' '[:lower:]')"
fi

# Bake branding (Console generator overwrites this before invoking build).
if [ -n "$BRANDING" ]; then
    if [ ! -f "$BRANDING" ]; then
        echo "ERROR: branding file not found: $BRANDING" >&2
        exit 1
    fi
    mkdir -p resources
    dest="resources/branding.json"
    branding_abs="$(readlink -f "$BRANDING" 2>/dev/null || realpath "$BRANDING" 2>/dev/null || echo "$BRANDING")"
    dest_abs="$(readlink -f "$dest" 2>/dev/null || realpath "$dest" 2>/dev/null || echo "$(pwd)/$dest")"
    if [ "$branding_abs" != "$dest_abs" ]; then
        cp "$BRANDING" "$dest"
    fi
    echo "Baked branding from $BRANDING"
fi

EXT=""
[ "$TARGET_OS" = "windows" ] && EXT=".exe"
if [ -z "$OUTPUT" ]; then
    mkdir -p dist
    OUTPUT="dist/betterdesk-support-${TARGET_OS}${EXT}"
fi

if [ "$TARGET_OS" = "windows" ]; then
    export CC="${CC:-x86_64-w64-mingw32-gcc}"
    export CXX="${CXX:-x86_64-w64-mingw32-g++}"
fi

BUILD_TAGS="release"
if [ "$TARGET_OS" = "windows" ] && [ -f "windows/opengl32.dll" ]; then
    BUILD_TAGS="release,mesaembed"
    echo "Embedding Mesa opengl32.dll for software OpenGL on Windows"
fi

WIN_LDFLAGS="-s -w -H=windowsgui"

linux_dual_build() {
    local out_dir launcher x11_bin wl_bin
    out_dir="$(dirname "$OUTPUT")"
    mkdir -p "$out_dir"
    x11_bin="${out_dir}/betterdesk-support-x11"
    wl_bin="${out_dir}/betterdesk-support-wayland"
    launcher="${out_dir}/betterdesk-support"

    echo "Building Linux X11 UI → $x11_bin ..."
    GOOS=linux CGO_ENABLED=1 "$GO" build -trimpath -tags release -ldflags "-s -w" -o "$x11_bin" .

    echo "Building Linux Wayland UI → $wl_bin ..."
    GOOS=linux CGO_ENABLED=1 "$GO" build -trimpath -tags "release,wayland" -ldflags "-s -w" -o "$wl_bin" .

    cp "$SCRIPT_DIR/scripts/betterdesk-support-launcher.sh" "$launcher"
    chmod +x "$launcher" "$x11_bin" "$wl_bin"
    echo "Built: $launcher (session launcher)"
    echo "       $x11_bin ($(du -h "$x11_bin" | cut -f1))"
    echo "       $wl_bin ($(du -h "$wl_bin" | cut -f1))"
}

if [ "$TARGET_OS" = "linux" ] && [ "$DUAL_LINUX" = 1 ]; then
    if [ -z "$OUTPUT" ]; then
        mkdir -p dist
        OUTPUT="dist/betterdesk-support"
    fi
    linux_dual_build
    exit 0
fi

echo "Building $OUTPUT (GOOS=$TARGET_OS) ..."
LDFLAGS="-s -w"
[ "$TARGET_OS" = "windows" ] && LDFLAGS="$WIN_LDFLAGS"
GOOS="$TARGET_OS" CGO_ENABLED=1 "$GO" build -trimpath \
    -tags "$BUILD_TAGS" \
    -ldflags "$LDFLAGS" \
    -o "$OUTPUT" .

echo "Built: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
