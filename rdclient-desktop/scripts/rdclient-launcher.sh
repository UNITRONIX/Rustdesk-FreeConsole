#!/usr/bin/env bash
# BetterDesk RdClient — Linux launcher (X11 + Wayland).
# Applies the same WebKit/GDK workarounds as the Rust startup hook, then execs the binary.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BIN="${RDCLIENT_DESKTOP_BIN:-$ROOT/src-tauri/target/debug/rdclient-desktop}"

if [ ! -x "$BIN" ]; then
    BIN="$ROOT/src-tauri/target/release/rdclient-desktop"
fi

if [ ! -x "$BIN" ]; then
    echo "rdclient-desktop: binary not found (run npm run build first)" >&2
    exit 1
fi

export BETTERDESK_LAUNCHED_VIA_SCRIPT=1

# Respect explicit operator overrides; otherwise mirror linux_display.rs defaults.
if [ -z "${GDK_BACKEND:-}" ]; then
    case "${BETTERDESK_UI_BACKEND:-}" in
        x11|x) export GDK_BACKEND=x11 ;;
        wayland|wl) export GDK_BACKEND=wayland ;;
        *)
            if [ -n "${WAYLAND_DISPLAY:-}" ] || [ "${XDG_SESSION_TYPE:-}" = wayland ]; then
                export GDK_BACKEND=wayland,x11
            elif [ -n "${DISPLAY:-}" ]; then
                export GDK_BACKEND=x11
            fi
            ;;
    esac
fi

    if [ -z "${BETTERDESK_WEBKIT_NO_WORKAROUND:-}" ]; then
        if [ -f /proc/driver/nvidia/version ]; then
            export __NV_DISABLE_EXPLICIT_SYNC="${__NV_DISABLE_EXPLICIT_SYNC:-1}"
            export __GL_THREADED_OPTIMIZATIONS="${__GL_THREADED_OPTIMIZATIONS:-0}"
        fi

        if [ -n "${BETTERDESK_WEBKIT_DISABLE_DMABUF:-}" ] || [ -n "${BETTERDESK_WEBKIT_SAFE:-}" ]; then
            export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
        elif [ -n "${WAYLAND_DISPLAY:-}" ] || [ "${XDG_SESSION_TYPE:-}" = wayland ] \
            || [ "${BETTERDESK_UI_BACKEND:-}" = wayland ] || [ "${BETTERDESK_UI_BACKEND:-}" = wl ]; then
            export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
        fi
    fi

exec "$BIN" "$@"
