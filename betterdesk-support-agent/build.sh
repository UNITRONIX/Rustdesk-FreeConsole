#!/usr/bin/env bash
# BetterDesk Support Agent — build helper.
#
# Produces the single self-contained binary that serves BOTH distribution
# forms (installer + portable). The Console "Generator agenta" calls this with
# a branding profile to bake per-deployment connection details and appearance.
#
# Usage:
#   ./build.sh [-b branding.json] [-o output] [-p linux|windows|darwin]
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
TARGET_OS="$(go env GOOS)"

while getopts "b:o:p:h" opt; do
    case $opt in
        b) BRANDING="$OPTARG" ;;
        o) OUTPUT="$OPTARG" ;;
        p) TARGET_OS="$OPTARG" ;;
        h) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) exit 1 ;;
    esac
done

# Bake branding (Console generator overwrites this before invoking build).
if [ -n "$BRANDING" ]; then
    if [ ! -f "$BRANDING" ]; then
        echo "ERROR: branding file not found: $BRANDING" >&2
        exit 1
    fi
    cp "$BRANDING" resources/branding.json
    echo "Baked branding from $BRANDING"
fi

EXT=""
[ "$TARGET_OS" = "windows" ] && EXT=".exe"
if [ -z "$OUTPUT" ]; then
    mkdir -p dist
    OUTPUT="dist/betterdesk-support-${TARGET_OS}${EXT}"
fi

echo "Building $OUTPUT (GOOS=$TARGET_OS) ..."
GOOS="$TARGET_OS" CGO_ENABLED=1 go build -trimpath \
    -ldflags "-s -w" \
    -o "$OUTPUT" .

echo "Built: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
