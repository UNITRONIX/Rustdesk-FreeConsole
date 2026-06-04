#!/usr/bin/env bash
# BetterDesk — agent build toolchain installer (Linux only)
#
# Provisions a host so the Node.js console can build branded agent installers
# locally (Phase 2 / Generator Agenta). Idempotent — safe to re-run.
#
# Native targets (build artifacts produced on Linux for Linux):
#   linux/x64/deb        Debian package
#   linux/x64/rpm        RPM package
#   linux/x64/AppImage   Portable AppImage
#
# Cross-compiled targets (built on Linux for Windows via cargo-xwin):
#   windows/x64/exe      NSIS installer wrapping the cross-built Tauri exe
#
# Usage:
#   sudo ./install-build-toolchain.sh [--unattended] [--skip-windows]
#
# Environment overrides:
#   BUILD_USER         user that runs cargo / tauri (default: unitronix)
#   BUILD_CACHE_DIR    cargo target dir (default: /var/cache/betterdesk-build)
#   RUSTUP_HOME        rustup install root (default: $BUILD_USER home/.rustup)
#   CARGO_HOME         cargo install root  (default: $BUILD_USER home/.cargo)

set -euo pipefail

UNATTENDED=0
SKIP_WINDOWS=0
for arg in "$@"; do
    case "$arg" in
        --unattended) UNATTENDED=1 ;;
        --skip-windows) SKIP_WINDOWS=1 ;;
        -h|--help)
            sed -n '2,25p' "$0"
            exit 0
            ;;
    esac
done

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: must run as root (use sudo)" >&2
    exit 1
fi

BUILD_USER="${BUILD_USER:-unitronix}"
if ! id "$BUILD_USER" >/dev/null 2>&1; then
    echo "ERROR: BUILD_USER '$BUILD_USER' does not exist on this host" >&2
    exit 1
fi

BUILD_HOME="$(getent passwd "$BUILD_USER" | cut -d: -f6)"
BUILD_CACHE_DIR="${BUILD_CACHE_DIR:-/var/cache/betterdesk-build}"
RUSTUP_HOME_DIR="${RUSTUP_HOME:-$BUILD_HOME/.rustup}"
CARGO_HOME_DIR="${CARGO_HOME:-$BUILD_HOME/.cargo}"

log()  { echo -e "\e[36m[toolchain]\e[0m $*"; }
warn() { echo -e "\e[33m[toolchain]\e[0m $*" >&2; }
err()  { echo -e "\e[31m[toolchain]\e[0m $*" >&2; }

detect_pkg_mgr() {
    if command -v apt-get >/dev/null 2>&1; then echo apt; return; fi
    if command -v dnf     >/dev/null 2>&1; then echo dnf; return; fi
    if command -v yum     >/dev/null 2>&1; then echo yum; return; fi
    if command -v zypper  >/dev/null 2>&1; then echo zypper; return; fi
    if command -v pacman  >/dev/null 2>&1; then echo pacman; return; fi
    echo unknown
}

PKG="$(detect_pkg_mgr)"
log "Package manager: $PKG"
log "Build user: $BUILD_USER  (home: $BUILD_HOME)"
log "Cargo target cache: $BUILD_CACHE_DIR"

# ---------------------------------------------------------------------------
# 1) System packages — build essentials, WebKit (Tauri Linux), packagers
# ---------------------------------------------------------------------------

install_apt() {
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    # Tauri 2 on Ubuntu 24.04 ships -4.1 variants; 22.04 may need -4.0.
    local WEBKIT_PKG="libwebkit2gtk-4.1-dev"
    if ! apt-cache show "$WEBKIT_PKG" >/dev/null 2>&1; then
        WEBKIT_PKG="libwebkit2gtk-4.0-dev"
    fi
    apt-get install -y --no-install-recommends \
        build-essential pkg-config curl wget git ca-certificates \
        libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
        libsoup-3.0-dev "$WEBKIT_PKG" \
        libgl1-mesa-dev libx11-dev libxcursor-dev libxrandr-dev \
        libxinerama-dev libxi-dev libxxf86vm-dev libxkbcommon-dev \
        nsis dpkg-dev rpm fakeroot \
        libfuse2t64 \
        mingw-w64 gcc-mingw-w64-x86-64
    # Node.js: prefer existing install (NodeSource bundles npm; the Ubuntu npm
    # package conflicts with it). Install only if neither node nor npm exist.
    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
        log "Installing Node.js LTS via NodeSource"
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
    fi
}

install_dnf() {
    dnf install -y \
        @development-tools pkgconf-pkg-config curl wget git ca-certificates \
        openssl-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel \
        libsoup3-devel webkit2gtk4.1-devel \
        libX11-devel libXcursor-devel libXrandr-devel libXinerama-devel \
        libXi-devel libXxf86vm-devel mesa-libGL-devel libxkbcommon-devel \
        mingw64-gcc mingw64-gcc-c++ \
        nsis rpm-build dpkg fuse-libs \
        nodejs npm || true
}

case "$PKG" in
    apt) install_apt ;;
    dnf|yum) install_dnf ;;
    *)
        err "Unsupported package manager '$PKG'. Install build deps manually."
        exit 2
        ;;
esac

# ---------------------------------------------------------------------------
# 2) Rust toolchain (as BUILD_USER, not root)
# ---------------------------------------------------------------------------

install_rust() {
    if sudo -u "$BUILD_USER" -H bash -lc "command -v cargo" >/dev/null 2>&1; then
        log "Rust already present for $BUILD_USER — updating"
        sudo -u "$BUILD_USER" -H bash -lc "rustup update stable"
    else
        log "Installing rustup + stable toolchain for $BUILD_USER"
        sudo -u "$BUILD_USER" -H bash -lc \
            "export RUSTUP_HOME='$RUSTUP_HOME_DIR' CARGO_HOME='$CARGO_HOME_DIR'; \
             curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
             sh -s -- -y --default-toolchain stable --profile minimal"
    fi
    # Ensure cargo/rustup are on PATH for future shells
    if ! grep -q 'cargo/env' "$BUILD_HOME/.bashrc" 2>/dev/null; then
        echo 'source "$HOME/.cargo/env"' >> "$BUILD_HOME/.bashrc"
        chown "$BUILD_USER:$BUILD_USER" "$BUILD_HOME/.bashrc"
    fi
}

install_rust

# Cargo helpers
sudo -u "$BUILD_USER" -H bash -lc "
    source \"\$HOME/.cargo/env\"
    rustup target add x86_64-unknown-linux-gnu
    if [[ $SKIP_WINDOWS -eq 0 ]]; then
        # cargo-xwin cross-compiles against the MSVC ABI (it bundles the
        # Windows SDK/CRT itself), so the MSVC target is what the build
        # worker selects -- NOT the gnu target.
        rustup target add x86_64-pc-windows-msvc
    fi
    cargo install --locked tauri-cli --version '^2.0' || true
    cargo install --locked cargo-xwin || true
"

# ---------------------------------------------------------------------------
# 3) AppImage tooling (no apt package on Ubuntu 24.04)
# ---------------------------------------------------------------------------

install_appimagetool() {
    if command -v appimagetool >/dev/null 2>&1; then
        log "appimagetool already installed"
        return
    fi
    log "Downloading appimagetool"
    local URL="https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
    curl -fsSL "$URL" -o /usr/local/bin/appimagetool
    chmod +x /usr/local/bin/appimagetool
}
install_appimagetool

# ---------------------------------------------------------------------------
# 4) pnpm (Tauri frontend uses npm by default; pnpm optional but faster)
# ---------------------------------------------------------------------------

if ! command -v pnpm >/dev/null 2>&1; then
    log "Installing pnpm globally"
    npm install -g pnpm@latest || warn "pnpm install failed (npm not present?)"
fi

# ---------------------------------------------------------------------------
# 5) Build cache directory (owned by BUILD_USER, isolated from $HOME)
# ---------------------------------------------------------------------------

mkdir -p "$BUILD_CACHE_DIR"
chown -R "$BUILD_USER:$BUILD_USER" "$BUILD_CACHE_DIR"
log "Build cache: $BUILD_CACHE_DIR  ($(df -h "$BUILD_CACHE_DIR" | awk 'NR==2 {print $4 " free"}'))"

# ---------------------------------------------------------------------------
# 6) Persist build env for systemd / Node worker
# ---------------------------------------------------------------------------

ENV_FILE="/etc/betterdesk/build.env"
mkdir -p "$(dirname "$ENV_FILE")"
cat > "$ENV_FILE" <<EOF
# Generated by install-build-toolchain.sh — sourced by agentBuildWorker.js
BUILD_USER=$BUILD_USER
BUILD_HOME=$BUILD_HOME
CARGO_HOME=$CARGO_HOME_DIR
RUSTUP_HOME=$RUSTUP_HOME_DIR
CARGO_TARGET_DIR=$BUILD_CACHE_DIR
GO_BIN=/usr/local/go/bin/go
PATH=/usr/local/go/bin:$CARGO_HOME_DIR/bin:/usr/local/bin:/usr/bin:/bin
EOF
chmod 644 "$ENV_FILE"
log "Wrote $ENV_FILE"

# ---------------------------------------------------------------------------
# 7) Summary
# ---------------------------------------------------------------------------

log "Verifying installed tools…"
sudo -u "$BUILD_USER" -H bash -lc "
    source \"\$HOME/.cargo/env\" 2>/dev/null || true
    for c in go cargo rustc cargo-tauri cargo-xwin pnpm node npm x86_64-w64-mingw32-gcc makensis dpkg-deb rpmbuild appimagetool; do
        if command -v \$c >/dev/null 2>&1; then
            v=\$(\$c --version 2>/dev/null | head -1 || echo '?')
            printf '  \e[32mOK\e[0m   %-26s %s\n' \"\$c\" \"\$v\"
        else
            printf '  \e[31mMISS\e[0m %s\n' \"\$c\"
        fi
    done
"

log "Done. Console service (betterdesk-console) should be restarted so the"
log "Node worker picks up the new \$PATH from $ENV_FILE."
