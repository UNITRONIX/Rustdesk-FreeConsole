# BetterDesk Support Agent

A lightweight quick-help remote desktop agent built as a **single self-contained
Go binary** (Fyne GUI). One codebase, one binary — two distribution forms:

| Form | How it runs | Autostart | State location |
|------|-------------|-----------|----------------|
| **Installer** | `betterdesk-support -install` then launches at login | XDG autostart / HKCU Run / LaunchAgent | per-user config dir |
| **Portable** | run the binary directly, no install | none | `data/` next to the binary (with a `portable` marker file) |

## Product identity and compatibility

BetterDesk Support Agent is a BetterDesk product and a passive remote-support
target. It does not provide an outbound “connect to peer” workflow.

Some releases include a desktop-client wire compatibility surface so approved
operators can connect to the Support Agent. That surface is being isolated
behind a BetterDesk compatibility adapter and is subject to the provenance gate
in [`../docs/important/support-agent-provenance.md`](../docs/important/support-agent-provenance.md).
Until that gate is complete, do not describe the compatibility component as a
fork, clone, clean-room implementation, or independently licensable component.

The remote-desktop engine is reused from the shared `betterdesk-agent` module,
so the support agent offers the same remote-desktop capabilities while exposing
only a minimal "quick help" surface.

## Quick-help UI

- **Your ID** — stable per-machine device ID (copy to clipboard).
- **Access password** — shown/hidden, copy, regenerate, or set a custom one.
- **Access mode** — *Ask each time* (supervised), *Unattended*, or *Disabled*.
- **Request help** — posts to the console `/api/bd/help-request` endpoint.
- **Test connection** — self-tests reachability of the CDAP gateway
  (`:21122/cdap/health`) and the web console (`:5000/health`) and reports each.
- **System tray** — keeps running in the background; window hides on close.

## Device-list marking

The agent registers with `device_type = os_agent` (required for remote-session
routing and accepted by the server's type validation) and carries identifying
**tags** that show up in the console device list:

- `support-agent` — always present, identifies this build.
- `portable` or `installed` — distinguishes the portable single-binary form
  from an installed copy.

## State encryption & anti-impersonation

Local state (device identity + access password) is stored **encrypted at rest**
with AES-256-GCM. The key is derived from a platform-stable machine identifier
(`/etc/machine-id` on Linux, `COMPUTERNAME` on Windows, hostname fallback) and a
domain-separation label, and never leaves the machine.

Because the key is machine-bound, a `state.json` copied to another machine fails
to decrypt; the agent then regenerates a fresh identity instead of cloning the
original device, preventing impersonation. Legacy plaintext state files are
migrated to the encrypted format on first load. The access password is still
shown to the local user through the UI (decrypted in memory on demand); the file
is additionally written with `0600` permissions.


## Branding

Appearance and connection details are **baked at build time** by the Console
Generator into `resources/branding.json` (embedded via `go:embed`). Release
builds require an Ed25519-signed profile; the matching public key is embedded
in the binary and any verification, expiry, or endpoint-allowlist failure
disables its connection profile. `BETTERDESK_BUNDLE_SIGNING_KEY_FILE` is
required for every distributed build. The legacy AES seal is accepted only by
non-release developer builds and is obfuscation, not a trust boundary. Fields:
`product_name`, `company_name`, `tagline`,
`support_email`, `primary_color`, `accent_color`, `logo_data_url`,
`default_language`, `allow_unattended`, `capabilities`, `server_address`,
`server_key`, `bundle_id`, `profile_issued_at`, `profile_expires_at`,
`allowed_endpoints`, and nested
`server { address, api_url, public_key, cert_pin, cdap_url }`.

Transport may be **HTTPS/WSS** (recommended on the public internet) or
**HTTP/WS** for LAN/IP deployments, matching the RustDesk model: management
and CDAP can use plaintext HTTP/WebSocket while remote-session crypto stays on
the signal/relay protocol layer. The signed `allowed_endpoints` list still
binds the agent to the baked URLs.

Optional build hardening:

```bash
BETTERDESK_USE_GARBLE=1 ./build.sh -b /tmp/branding.json   # needs garble in PATH
BETTERDESK_USE_UPX=1 ./build.sh -p windows                 # opt-in; may trip AV
```

Override for local testing without rebuilding (non-release builds only):

```bash
BETTERDESK_AGENT_BRANDING=/path/to/branding.json ./betterdesk-support
```

## Connection resilience

The agent remembers last-known healthy endpoint metadata in encrypted local
state. Distributed builds use only the HTTPS/WSS endpoints explicitly allowed
by their signed profile; they never downgrade to HTTP/WS after a failure.

## Build

```bash
# Generate or provide an Ed25519 PKCS#8 key outside the workspace, then build.
BETTERDESK_BUNDLE_SIGNING_KEY_FILE=/secure/path/branding-ed25519.pem \
  ./build.sh

# With a generated branding profile
BETTERDESK_BUNDLE_SIGNING_KEY_FILE=/secure/path/branding-ed25519.pem \
  ./build.sh -b /tmp/branding.json -o dist/acme-support

# Windows target (needs mingw-w64 CGO toolchain)
./build.sh -p windows
```

### Linux build dependencies

Linux builds ship **two UI binaries** (X11 and Wayland) plus a launcher that picks
the right one for the current session. Build with `./build.sh -p linux -d`.

```bash
# Fedora
sudo dnf install -y libXxf86vm-devel libXcursor-devel libXrandr-devel \
    libXinerama-devel libXi-devel mesa-libGL-devel wayland-devel libdecor-devel
# Debian/Ubuntu
sudo apt install -y libgl1-mesa-dev xorg-dev libwayland-dev libdecor-0-dev
```

Force a backend: `BETTERDESK_UI_BACKEND=wayland` or `=x11`.

## Install / uninstall

```bash
./betterdesk-support -install     # copy to per-user dir + enable autostart
./betterdesk-support -uninstall   # remove autostart + installed binary
```

## System requirements

| Platform | Minimum |
|----------|---------|
| Windows | 10 / Server 2016+ (64-bit). Fyne requires OpenGL 2.0+; use Mesa companion DLL or `-nogui` on VMs/RDP. |
| Linux | glibc-based distros with X11 or Wayland; dual UI binaries included. AppImage, deb, rpm, portable tar supported. |
| macOS | 11+ (experimental cross-compile) |

Portable and installed builds behave identically except for state location and autostart. A portable binary added to autostart hides to the tray on close like the installed build.

## Portable usage

**Tarball / bare binary:** place an empty `portable` (or `.portable`) file next to
the binary; state is written to a `data/` folder beside it.

**AppImage:** no marker needed — the runtime sets `APPIMAGE` and state is stored
in `betterdesk-support-data/` next to the `.AppImage` file (the mount is read-only).

### Windows without OpenGL (VM / RDP)

Fyne needs a working OpenGL 2.0+ driver (WGL). If you see
`WGL: The driver does not appear to support OpenGL`:

1. Update the graphics driver, or install
   [OpenGL Compatibility Pack](https://apps.microsoft.com/detail/9nqpsl29bfff) from Microsoft Store.
2. Or run without GUI (remote engine only):

```bat
betterdesk-support.exe -nogui
```

Supervised consent prompts require the GUI; use unattended access mode for `-nogui`.

## Environment variables

| Variable | Effect |
|----------|--------|
| `BETTERDESK_AGENT_BRANDING` | Load branding from an external JSON file |
| `BETTERDESK_AGENT_DATA_DIR` | Force the state directory |
| `BETTERDESK_CDAP_TLS=1` | Enable TLS in non-release developer profiles |
| `BETTERDESK_AGENT_INSECURE_TLS=1` | Non-release-only local self-signed test override; ignored by release binaries |
