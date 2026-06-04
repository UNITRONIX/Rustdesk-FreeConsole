#!/bin/sh
# Picks the Fyne binary matching the active Linux session (Wayland vs X11).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
X11="$HERE/betterdesk-support-x11"
WL="$HERE/betterdesk-support-wayland"
LEGACY="$HERE/betterdesk-support.bin"

if [ -n "${BETTERDESK_UI_BACKEND:-}" ]; then
    case "$BETTERDESK_UI_BACKEND" in
        wayland|wl) BACKEND=wayland ;;
        x11|x)    BACKEND=x11 ;;
        *)        BACKEND=x11 ;;
    esac
elif [ -n "${WAYLAND_DISPLAY:-}" ] && [ -z "${DISPLAY:-}" ]; then
    BACKEND=wayland
else
    BACKEND=x11
fi

if [ "$BACKEND" = wayland ] && [ -x "$WL" ]; then
    exec "$WL" "$@"
fi
if [ -x "$X11" ]; then
    exec "$X11" "$@"
fi
if [ -x "$LEGACY" ]; then
    exec "$LEGACY" "$@"
fi
echo "betterdesk-support: no UI binary found in $HERE" >&2
exit 1
