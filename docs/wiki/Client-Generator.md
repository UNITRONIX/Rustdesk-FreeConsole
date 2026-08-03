# Client Generator

The **Agent Generator** in the web console builds branded **BetterDesk Support Agent** installers with your server address, public key, and appearance baked in. End users download from a public hub page — no manual network configuration.

> Legacy RustDesk TOML generation remains in the API for compatibility but is no longer the primary UI path.

---

## What you get

Each Support Agent bundle includes:

- Server / API / CDAP connection profile
- Server public key
- Company branding (colors, logo, product name, contact)
- Optional unattended access flag
- Incoming capability defaults (desktop, files, clipboard, audio, terminal, restart)

### Platforms (Windows + Linux)

| Platform | Formats |
|----------|---------|
| Windows x64 | Portable `.exe`, installed `.msi` |
| Linux x64 | Portable `.tar.gz`, AppImage, `.deb`, `.rpm` |

---

## Quick start

1. Log in as **admin**
2. Open **Generator** in the sidebar
3. Click **New Support Agent bundle**
4. Fill company name, branding, and public server host
5. Save — the build worker queues all platforms
6. Watch build status (Ready / Queued / Building / Failed); use **Retry** on failed platforms
7. Share the download hub link (`/d/:slug`)

### After a BetterDesk update

When agent source changes, the panel syncs `agent-source/` and **requeues all non-revoked bundles** immediately (and again on console restart as a safety net). Check Settings → Updates log for “Support Agent generator rebuild queued…”.

### Toolchain

Support Agent builds need Go + CGO on the console host (mingw for Windows cross-builds, `wixl` for MSI, packaging tools for Linux). The Generator shows a toolchain status banner when tools are missing.

---

## Security notes

- Bundles do **not** embed a shared enrollment token
- Each install registers independently; in **managed** mode a unique `device_token` is issued only after operator approval
- Release builds seal branding inside the binary (obfuscation + integrity); local state is machine-bound AES-GCM
- Support Agent is **inbound-only** — end users cannot browse or connect to other devices on your infrastructure
