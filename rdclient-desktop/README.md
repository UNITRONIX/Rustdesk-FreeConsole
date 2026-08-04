# BetterDesk RdClient Desktop

Tauri v2 desktop shell for the RdClient operator UI. The app loads your panel’s **`/remote`** dashboard in the main window and opens each remote session in a **separate window** (`/remote/:deviceId`), similar to RustDesk.

This is **production-ready Phase C+** of the RdClient roadmap: server validation, LAN discovery, settings/reset, encrypted peer passwords, full panel i18n, codec fallbacks on Linux, and generator-built installers with embedded panel URL.

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

1. On first launch, enter your panel base URL (e.g. `https://desk.example.com`) or pick a server from **LAN discovery**.
2. Sign in at **`/remote/login`** when prompted (same as the web RdClient).
3. Use **Connect** on a device — the desktop opens a new window instead of a browser tab.
4. Open **Settings** (gear icon in the dashboard header) to change URL, TLS mode, language, sign out, or **Reset client** (clears config, cookies, and saved passwords).

### File transfer (desktop)

Remote sessions use the panel’s RustDesk **FILE_TRANSFER** channel (toolbar **File transfer** button). Prefer this channel for **large files and folder trees** — it uses a dedicated relay so the desktop video session stays interactive. Cliprdr copy/paste remains convenient for small Explorer transfers, not multi‑GB bulk moves.

| Action | Desktop behaviour |
|--------|-------------------|
| **Upload files** | Drag files onto the modal or remote pane; click the drop zone for a native multi-file picker; optional **Choose folder** to browse local directories |
| **Upload folders** | Double-click / context menu **Upload folder**, or drop a folder path onto the modal — expands the tree, creates remote dirs, uploads files sequentially under one queue job |
| **Download files** | Streaming **Save as** — blocks are appended to disk (no full-file buffer in the WebView) |
| **Download folders** | Context menu / double-click **Download folder** — pick (or use) a local destination, walk remote `read_dir`, `mkdir`, stream each file |
| **Queue** | Folder jobs show overall % + current file name; **Cancel** stops the active child and remaining items. One folder job runs at a time (others queue) |
| **Performance** | Chunk IPC uses base64 (not JSON number arrays); download writes are batched; queue UI is throttled. Rebuild desktop **and** update panel together after FT changes |
| **Protocol** | Same `RDFileTransfer` / dedicated file relay as the web RdClient — browse, upload, download, overwrite prompts |

Rebuild the desktop binary after pulling `rdclient-desktop` changes. Deploy or update the panel so `/js/rdclient/local-files.js`, `filetransfer.js`, and `file-modal.js` are current on your server.

### Cliprdr file paste (desktop, Windows)

Explorer **Copy** / **Ctrl+C** on either side → focus the other → **Ctrl+V** uses RustDesk **Cliprdr** (same path as the native RustDesk client), separate from the file-transfer modal. Dragging files onto the session window also registers them for remote paste (native Tauri drop paths).

| Direction | Behaviour |
|-----------|-----------|
| **Local → remote (copy/paste)** | Windows CF_HDROP paths read natively; file tree expanded into FILEGROUPDESCRIPTORW PDUs; peer Ctrl+V pulls chunks |
| **Local → remote (drag-drop)** | OS drop onto the session window → Cliprdr FormatList → click under the cursor → synthetic Ctrl+V (not shell DnD into a folder HWND). Open the **File transfer** modal first to upload into a chosen remote folder instead |
| **Remote → local (drag-out)** | Drag a file on the remote toward the **edge of the RdClient window** (keep the button down). RdClient cancels the remote Explorer drag, sends Ctrl+C, downloads via Cliprdr, then starts a local OLE drag so you can drop on Desktop/Explorer. Plain **Copy → Paste** also works |
| **Remote → local (copy/paste)** | Peer FormatList → RdClient requests descriptor + file bytes into a temp dir → CF_HDROP on the local clipboard for Explorer paste |
| **Cliprdr performance** | File bytes move in chunks over the shared session relay (same as RustDesk). RdClient uses base64 IPC + UI yields so video/heartbeat keep running during modest copy/paste. Selections over **~300 entries or ~200 MB** are refused for Cliprdr (toast steers you to **File transfer**) so remote Explorer does not freeze on Paste. For large trees always use toolbar **File transfer** — dedicated FILE_TRANSFER connection |
| **Drag-drop plumbing** | Native `tauri://drag-drop` paths (do **not** use `disable_drag_drop_handler` — HTML5 drops lack paths in WebView2) |
| **Sync trigger** | Window focus / click in the viewer, ~1.5s poll while streaming, or native file drop |
| **Text race guard** | When CF_HDROP is present, focus sync skips text clipboard push so path-as-text cannot wipe file formats on the peer |
| **File transfer modal** | Open modal → drop files on the remote pane or drop zone → uploads via `desktop_open_paths` |

Requires a rebuilt desktop binary **and** panel JS (`cliprdr.js`, updated `client.js` / `protocol.js` / `remote.js` / `desktop-dnd.js`). Linux/macOS Cliprdr is not implemented yet.

### Environment & embedded URL

| Source | Purpose |
|--------|---------|
| `BETTERDESK_SERVER_URL` | Auto-configure panel URL before setup UI |
| `betterdesk-rdclient.json` next to the binary | Installer-embedded `{ "server_url": "https://…" }` from Generator |
| UDP / mDNS LAN discovery | Setup UI lists panels on the local network |

### Password storage

- **Operator login (“Remember me”):** `RdClientSecureStore` in IndexedDB (AES-GCM).
- **Device password (“Remember device password”):** same vault, per `deviceId` (`peer:{id}` keys). Passwords never leave the device.
- **Reset client:** clears `config.json`, WebView cookies/storage, and the vault.

### LAN discovery

The panel publishes itself via UDP (port **21119**, always on) and optionally mDNS `_betterdesk._tcp` when `bonjour-service` is installed and `PANEL_MDNS` is not `off`.

## Build

```bash
npm run build
```

Installers/binaries are under `src-tauri/target/release/bundle/`.

## How it works

| Piece | Role |
|-------|------|
| `src/setup.html` | First-run: LAN discovery list + manual panel URL |
| `src/settings.html` | Local settings: URL, TLS, language, sign out, reset |
| `src-tauri/src/lib.rs` | Tauri commands: probe, discover, settings, sign out, reset, sessions |
| `src-tauri/src/config.rs` | Persists extended config + embedded/env URL helpers |
| `src-tauri/src/server_probe.rs` | Validates panel via `/api/bd/server-info` |
| `src-tauri/src/discovery.rs` | UDP LAN browse (BetterDesk announce protocol) |
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

## Verify matrix (manual)

| Platform | Check |
|----------|--------|
| **Linux Wayland** | Setup discovery, login, VP9/H.264 session (no AV1 loop), settings reset |
| **Linux X11** | Same as Wayland; test `BETTERDESK_UI_BACKEND=x11` if needed |
| **Windows x64** | WebView2 present, Connect, remember passwords, MSI/portable from Generator |
| **Fedora deb/rpm** | Installed bundle from Generator when build host has toolchain |

## Roadmap (not in this release)

- Operator JWT + OS keychain login (`POST /api/bd/operator/login`)
- WebSocket relay Bearer auth for long-lived desktop sessions
- Native Rust video decoder (if WebCodecs insufficient on Linux)

## License

AGPL-3.0 (same as BetterDesk on `dev`).
