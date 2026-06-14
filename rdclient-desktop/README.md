# BetterDesk RdClient Desktop

Tauri v2 desktop shell for the RdClient operator UI. The app loads your panel’s **`/remote`** dashboard in the main window and opens each remote session in a **separate window** (`/remote/:deviceId`), similar to RustDesk.

This is **Phase C (MVP)** of the RdClient roadmap. It reuses the web dashboard and login flow; JWT/keychain auth is planned for a later phase.

## Prerequisites

- **Node.js** 18+ (for `@tauri-apps/cli`)
- **Rust** stable (1.77+; tested with Fedora’s toolchain)
- **Linux:** `webkit2gtk-4.1`, `libayatana-appindicator3`, `librsvg2`, `patchelf` (Tauri [Linux deps](https://v2.tauri.app/start/prerequisites/))

## Platforms

| OS | Support |
|----|---------|
| **Windows** | Native Tauri / WebView2 |
| **Linux X11** | Native GTK + WebKitGTK |
| **Linux Wayland** | Native Wayland with automatic WebKit workarounds (KDE, GNOME, NVIDIA) |

Session detection and GDK/WebKit env setup run in `src-tauri/src/linux_display.rs` **before** GTK starts (also available via `scripts/rdclient-launcher.sh` for packaged installs).

### TLS (HTTP / self-signed / Let's Encrypt)

RdClient targets **self-hosted operator panels**. By default it accepts:

- **`http://`** panel URLs (no TLS)
- **`https://`** with **self-signed** BetterDesk installer certs
- **`https://`** with **Let's Encrypt** or commercial CAs (including incomplete intermediate chains on LAN)

| Platform | Mechanism |
|----------|-----------|
| **Linux** | Patched WebKitGTK `TLSErrorsPolicy::Ignore` on each WebContext (`vendor/wry`) |
| **Windows** | WebView2 `--ignore-certificate-errors` |

Strict validation (system trust store only):

```bash
BETTERDESK_TLS_STRICT=1 npm run dev
```

Use strict mode only when the panel serves a **complete, publicly trusted chain** and you do not need LAN/self-signed access.

### Linux troubleshooting (Gdk error 71 / Wayland)

If the window fails to open on Wayland with:

```text
Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display.
```

the app already applies common fixes automatically. You can override:

| Variable | Effect |
|----------|--------|
| `BETTERDESK_UI_BACKEND=x11` | Force XWayland / X11 (`GDK_BACKEND=x11`) |
| `BETTERDESK_UI_BACKEND=wayland` | Force native Wayland |
| `BETTERDESK_WEBKIT_DISABLE_DMABUF=1` | Set `WEBKIT_DISABLE_DMABUF_RENDERER=1` (disables GPU compositing — use if blank window / flicker) |
| `BETTERDESK_WEBKIT_NO_MEDIA_ACCEL=1` | Skip GStreamer VA-API hints for WebKit media decode |
| `BETTERDESK_WEBKIT_NO_WORKAROUND=1` | Skip all automatic WebKit/GDK tweaks |
| `BETTERDESK_WEBKIT_NO_COMPOSITING=1` | Set `WEBKIT_DISABLE_COMPOSITING_MODE=1` (last resort) |

**NVIDIA + Wayland:** the binary sets `__NV_DISABLE_EXPLICIT_SYNC=1` when `/proc/driver/nvidia/version` exists and keeps DMA-BUF enabled for GPU compositing. **NVIDIA + X11:** DMA-BUF is disabled automatically (blank-window workaround).

**GPU / codecs:** Wayland keeps WebKit DMA-BUF/GPU compositing enabled by default. Vendor-specific VA-API drivers are auto-selected (Intel `iHD`, AMD `radeonsi`, NVIDIA when `nvidia-vaapi-driver` is installed). GStreamer ranks hardware decoders (`vaav1dec`, `vah264dec`, …) above software. WebView2 on Windows enables GPU rasterization, AV1/HEVC HW decode, and WebCodecs.

**Linux packages (recommended for AV1 / smooth remote):**

| GPU | Packages (Fedora example) |
|-----|-----------------------------|
| **Intel** | `libva-intel-media-driver`, `gstreamer1-vaapi`, `gstreamer1-plugins-bad-free` |
| **AMD** | `mesa-va-drivers`, `gstreamer1-vaapi`, `gstreamer1-plugins-bad-free` |
| **NVIDIA** | `nvidia-vaapi-driver` (optional VA-API), `gstreamer1-plugins-bad-free` |

Verify VA-API: `vainfo` (should list AV1/H264/VP9 profiles). WebKitGTK **2.44+** and GStreamer **1.24+** are required for WebCodecs + DMA-BUF zero-copy.

If the window is blank or flickers, set `BETTERDESK_WEBKIT_DISABLE_DMABUF=1`.

Examples:

```bash
# Force X11 session (works on XWayland)
BETTERDESK_UI_BACKEND=x11 npm run dev

# Wayland with extra-safe WebKit flags
BETTERDESK_WEBKIT_DISABLE_DMABUF=1 npm run dev
```

## Quick start

```bash
cd rdclient-desktop
npm install
npm run dev
```

### Clean rebuild (no Cargo cache)

If Connect still does nothing after pulling changes, force a full rebuild:

```bash
cd rdclient-desktop
./scripts/rebuild-clean.sh
```

Production bundle instead of dev:

```bash
./scripts/rebuild-clean.sh build
```

**Important:** the dashboard HTML/JS is loaded from your **panel URL** (`/remote`). Updating only the desktop binary is not enough for UI tweaks — run **Settings → Updates** on the panel (or deploy `web-nodejs`) so `/js/remote-dashboard.js` is current. The desktop shell also injects a Connect bridge, so **Connect works even before the panel JS update** once you run a freshly built binary.

1. On first launch, enter your panel base URL (e.g. `https://desk.example.com`).
2. Sign in at **`/remote/login`** when prompted (same as the web RdClient).
3. Use **Connect** on a device — the desktop opens a new window instead of a browser tab.

## Build

```bash
npm run build
```

Installers/binaries are under `src-tauri/target/release/bundle/`.

## How it works

| Piece | Role |
|-------|------|
| `src/setup.html` | First-run local page to save the panel URL |
| `src-tauri/src/lib.rs` | Tauri commands: `get_server_url`, `set_server_url`, `open_session` |
| `src-tauri/src/config.rs` | Persists `server_url` in the app config dir |
| `src-tauri/src/linux_display.rs` | Linux X11/Wayland session + WebKitGTK workarounds |
| `src-tauri/src/tls_policy.rs` | Windows WebView2 + strict-mode env |
| `scripts/rdclient-launcher.sh` | Optional wrapper for release binaries |
| `vendor/wry/` | Linux WebKit TLS policy patch (see `vendor/README.md`) |
| `web-nodejs/public/js/remote-dashboard.js` | Detects `window.__TAURI__` and calls `open_session` |

Config file: **`config.json`** in the OS app config directory (`com.betterdesk.rdclient`).

## Dependency note (brotli / alloc-no-stdlib)

`Cargo.lock` pins a git patch for `alloc-no-stdlib` so `brotli` (via Tauri) compiles with a single allocator version. If a fresh `cargo update` reintroduces `alloc-no-stdlib` 2.x and the build fails, run once from `src-tauri/`:

```bash
cargo update -p alloc-no-stdlib@2.0.4 --precise 3.0.0
```

## Roadmap (not in this MVP)

- Operator JWT + OS keychain login (`POST /api/bd/operator/login`)
- WebSocket relay Bearer auth for long-lived desktop sessions
- Settings → change server URL / sign out
- CI release artifacts (replacing legacy `betterdesk-mgmt`)

## License

AGPL-3.0 (same as BetterDesk on `dev`).
