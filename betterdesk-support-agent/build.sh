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
#   -p OS     Target OS (default: host OS). Default UI is Wails (WebView2 /
#             WebKit). Set BETTERDESK_SUPPORT_FYNEUI=1 for legacy Fyne builds
#             (needs OpenGL/Mesa on Windows). Cross-compiling still needs the
#             matching CGO toolchain (mingw-w64 for windows).
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

SIGNING_KEY_FILE="${BETTERDESK_BUNDLE_SIGNING_KEY_FILE:-}"
if [ -z "$SIGNING_KEY_FILE" ]; then
    echo "ERROR: release builds require BETTERDESK_BUNDLE_SIGNING_KEY_FILE" >&2
    exit 1
fi
if [ ! -f "$SIGNING_KEY_FILE" ]; then
    echo "ERROR: BETTERDESK_BUNDLE_SIGNING_KEY_FILE does not exist: $SIGNING_KEY_FILE" >&2
    exit 1
fi

seal_branding() {
    # Pure-Go helper — must not inherit mingw CC/CXX or host CGO from the
    # Windows cross-compile env (that compiles runtime/cgo with the wrong CC).
    local args
    args=(-in resources/branding.json -out resources/branding.json)
    if [ -n "$SIGNING_KEY_FILE" ]; then
        args+=(-signing-key-file "$SIGNING_KEY_FILE" -public-key-out resources/branding.pub)
    fi
    CGO_ENABLED=0 CC= CXX= "$GO" run ./cmd/sealbranding "${args[@]}"
}

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

# Do NOT export mingw CC/CXX here — seal_branding (and any host go run) must
# use the native toolchain. Windows CC is applied only around the final build.

# Default UI: Wails (embedded frontend/dist). Legacy Fyne remains behind the
# fyneui build tag for emergency rebuilds.
BUILD_TAGS="release"
if [ "${BETTERDESK_SUPPORT_FYNEUI:-0}" = "1" ]; then
    BUILD_TAGS="release,fyneui"
    if [ "$TARGET_OS" = "windows" ] && [ -f "windows/opengl32.dll" ] && [ -f "windows/libgallium_wgl.dll" ]; then
        BUILD_TAGS="release,fyneui,mesaembed"
        echo "Legacy Fyne UI: embedding Mesa OpenGL DLLs"
    fi
fi

if [ ! -f "frontend/ui/index.html" ]; then
    echo "ERROR: frontend/ui/index.html missing (Wails UI assets)" >&2
    exit 1
fi

WIN_LDFLAGS="-s -w -H=windowsgui"

linux_dual_build() {
    local out_dir launcher x11_bin wl_bin bak pub_bak
    out_dir="$(dirname "$OUTPUT")"
    mkdir -p "$out_dir"
    x11_bin="${out_dir}/betterdesk-support-x11"
    wl_bin="${out_dir}/betterdesk-support-wayland"
    launcher="${out_dir}/betterdesk-support"

    bak="$(mktemp)"
    pub_bak=""
    cp resources/branding.json "$bak"
    if [ -f resources/branding.pub ]; then
        pub_bak="$(mktemp)"
        cp resources/branding.pub "$pub_bak"
    fi
    if ! seal_branding; then
        cp "$bak" resources/branding.json
        if [ -n "$pub_bak" ] && [ -f "$pub_bak" ]; then
            cp "$pub_bak" resources/branding.pub
        fi
        if [ -n "$SIGNING_KEY_FILE" ]; then
            echo "ERROR: signed branding profile could not be created" >&2
            rm -f "$bak" "$pub_bak"
            return 1
        fi
    fi

    echo "Building Linux X11 UI → $x11_bin ..."
    GOOS=linux CGO_ENABLED=1 "$GO" build -trimpath -tags release -ldflags "-s -w" -o "$x11_bin" .

    echo "Building Linux Wayland UI → $wl_bin ..."
    GOOS=linux CGO_ENABLED=1 "$GO" build -trimpath -tags "release,wayland" -ldflags "-s -w" -o "$wl_bin" .

    cp "$bak" resources/branding.json
    if [ -n "$pub_bak" ] && [ -f "$pub_bak" ]; then
        cp "$pub_bak" resources/branding.pub
    fi
    rm -f "$bak"
    rm -f "$pub_bak"

    cp "$SCRIPT_DIR/scripts/betterdesk-support-launcher.sh" "$launcher"
    chmod +x "$launcher" "$x11_bin" "$wl_bin"
    echo "Built: $launcher (session launcher)"
    echo "       $x11_bin ($(du -h "$x11_bin" | cut -f1))"
    echo "       $wl_bin ($(du -h "$wl_bin" | cut -f1))"
}

if [ "$TARGET_OS" = "linux" ] && [ "$DUAL_LINUX" = 1 ]; then
    if [ "${BETTERDESK_SUPPORT_FYNEUI:-0}" = "1" ]; then
        if [ -z "$OUTPUT" ]; then
            mkdir -p dist
            OUTPUT="dist/betterdesk-support"
        fi
        linux_dual_build
        exit 0
    fi
    echo "Note: Wails UI uses a single Linux binary (ignoring -d X11/Wayland split)"
fi

# Seal branding for release embeds (plaintext restored after build).
BRANDING_PLAIN_BAK=""
BRANDING_PUB_BAK=""
if [ -f resources/branding.json ]; then
    BRANDING_PLAIN_BAK="$(mktemp)"
    cp resources/branding.json "$BRANDING_PLAIN_BAK"
    if [ -f resources/branding.pub ]; then
        BRANDING_PUB_BAK="$(mktemp)"
        cp resources/branding.pub "$BRANDING_PUB_BAK"
    fi
    if seal_branding; then
        echo "Signed branding profile for release embed"
    else
        echo "ERROR: branding signing failed; refusing to embed plaintext" >&2
        cp "$BRANDING_PLAIN_BAK" resources/branding.json
        if [ -n "$BRANDING_PUB_BAK" ] && [ -f "$BRANDING_PUB_BAK" ]; then
            cp "$BRANDING_PUB_BAK" resources/branding.pub
        fi
        exit 1
    fi
fi
restore_branding() {
    if [ -n "$BRANDING_PLAIN_BAK" ] && [ -f "$BRANDING_PLAIN_BAK" ]; then
        cp "$BRANDING_PLAIN_BAK" resources/branding.json
        rm -f "$BRANDING_PLAIN_BAK"
    fi
    if [ -n "$BRANDING_PUB_BAK" ] && [ -f "$BRANDING_PUB_BAK" ]; then
        cp "$BRANDING_PUB_BAK" resources/branding.pub
        rm -f "$BRANDING_PUB_BAK"
    fi
}
trap restore_branding EXIT

echo "Building $OUTPUT (GOOS=$TARGET_OS) ..."
LDFLAGS="-s -w"
[ "$TARGET_OS" = "windows" ] && LDFLAGS="$WIN_LDFLAGS"

BUILD_CMD=("$GO" build -trimpath -tags "$BUILD_TAGS" -ldflags "$LDFLAGS" -o "$OUTPUT" .)
if [ "${BETTERDESK_USE_GARBLE:-0}" = "1" ] && command -v garble >/dev/null 2>&1; then
    echo "Using garble for release obfuscation"
    BUILD_CMD=(garble -literals -tiny build -trimpath -tags "$BUILD_TAGS" -ldflags "$LDFLAGS" -o "$OUTPUT" .)
fi

if [ "$TARGET_OS" = "windows" ]; then
    export CC="${CC:-x86_64-w64-mingw32-gcc}"
    export CXX="${CXX:-x86_64-w64-mingw32-g++}"
fi
GOOS="$TARGET_OS" CGO_ENABLED=1 "${BUILD_CMD[@]}"

# Optional UPX pack (Windows portable) — opt-in; can trigger AV false positives.
if [ "${BETTERDESK_USE_UPX:-0}" = "1" ] && command -v upx >/dev/null 2>&1; then
    echo "Packing with UPX…"
    upx -q --best "$OUTPUT" || echo "WARN: upx failed" >&2
fi

echo "Built: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
restore_branding
trap - EXIT
