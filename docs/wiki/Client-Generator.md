# Client Generator

The **Support Agent Generator** in the web console builds branded **BetterDesk Support Agent** installers with your server address, public key, and appearance baked in. End users download from a public hub page — no manual network configuration.

BetterDesk focuses on **Support Agent** as the supported end-user client. Legacy Agent Client / RdClient workers may still exist in the codebase but are not offered in the Generator UI.

---

## What you get

Each Support Agent bundle includes:

- Server / API / CDAP connection profile
- Server public key
- Optional company branding (colors, logo, product name, contact)
- Optional unattended access flag
- Incoming capability defaults (desktop, files, clipboard, audio, terminal, restart)

### Platforms (Windows + Linux)

| Platform | Formats |
|----------|---------|
| Windows x64 | Portable `.exe`, installed `.msi` |
| Linux x64 | Portable `.tar.gz`, AppImage, `.deb`, `.rpm` |

You can deselect platforms when creating or rebuilding a bundle (for example Windows-only) to shorten the first build.

---

## Quick start

1. Log in as **admin**
2. Open **Generator** in the sidebar
3. Click **New Support Agent**
4. Enter an internal bundle name and confirm the public server host (prefilled from console defaults)
5. Optionally expand **Branding & appearance** for logo / colors / contact
6. Confirm build platforms (all selected by default) and **Save**
7. Watch build status (Ready / Queued / Building / Failed); use **Retry** on failed platforms
8. Share the download hub link (`/d/:slug`)

### After a BetterDesk update

When agent source changes, the panel syncs `agent-source/` and **requeues all non-revoked Support Agent bundles** immediately (and again on console restart as a safety net). Check Settings → Updates log for “Support Agent generator rebuild queued…”.

If a Support Agent signed profile is **incomplete or expired**, Rebuild / Retry / auto-requeue **re-issues** the profile (connection URLs + TTL) before compiling. You can still **Save** the bundle in Generator to refresh the profile manually.

### Toolchain

Support Agent builds need Go + CGO on the console host:

- **mingw-w64** for Windows cross-builds (`x86_64-w64-mingw32-gcc`)
- **wixl** (msitools) for MSI
- **appimagetool** as an **extracted wrapper** under `/usr/local/lib/appimagetool` (raw AppImage in `/usr/local/bin` fails for the `betterdesk` service user)
- `dpkg-deb` / `rpmbuild` for Linux packages
- **WebView2** runtime on end-user Windows machines (Wails UI; usually preinstalled on Windows 10/11)
- **webkit2gtk** on Linux build/runtime hosts for the Wails UI

Install via `sudo ./scripts/install-build-toolchain.sh` or `betterdesk.sh` menu **B**, then restart `betterdesk-console`. The Generator banner reports Go, mingw, wixl, and appimagetool.

**UI:** Support Agent defaults to **Wails** (HTML UI + Go bindings). Legacy Fyne builds remain available with `BETTERDESK_SUPPORT_FYNEUI=1` (may embed Mesa OpenGL DLLs). Remote desktop capture uses ffmpeg (`ddagrab`/`gdigrab` on Windows) with hardware H.264/VP8/VP9/AV1/H.265 when available.

**Note:** Do not set mingw `CC` before branding seal — `sealbranding` is a host (Linux) Go tool and must run with `CGO_ENABLED=0` / native compilers. Windows `CC`/`CXX` apply only to the final cross-compile.

---

## Security notes

- Bundles do **not** embed a shared enrollment token
- Each install registers independently; in **managed** mode a unique `device_token` is issued only after operator approval
- Release builds seal branding inside the binary (obfuscation + integrity); local state is machine-bound AES-GCM
- Support Agent is **inbound-only** — end users cannot browse or connect to other devices on your infrastructure
