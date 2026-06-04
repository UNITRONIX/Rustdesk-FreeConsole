# BetterDesk Support Agent

A lightweight quick-help remote desktop agent built as a **single self-contained
Go binary** (Fyne GUI). One codebase, one binary — two distribution forms:

| Form | How it runs | Autostart | State location |
|------|-------------|-----------|----------------|
| **Installer** | `betterdesk-support -install` then launches at login | XDG autostart / HKCU Run / LaunchAgent | per-user config dir |
| **Portable** | run the binary directly, no install | none | `data/` next to the binary (with a `portable` marker file) |

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
"Generator agenta" into `resources/branding.json` (embedded via `go:embed`).
Fields: `product_name`, `company_name`, `tagline`, `support_email`,
`primary_color`, `accent_color`, `logo_data_url`, `default_language`,
`allow_unattended`, `server_address`, `server_key`, `api_key`, and a nested
`server { address, api_url, public_key }`.

Override for local testing without rebuilding:

```bash
BETTERDESK_AGENT_BRANDING=/path/to/branding.json ./betterdesk-support
```

## Build

```bash
# Host platform, unbranded
./build.sh

# With a generated branding profile
./build.sh -b /tmp/branding.json -o dist/acme-support

# Windows target (needs mingw-w64 CGO toolchain)
./build.sh -p windows
```

### Linux build dependencies

Fyne needs X11/GL development headers:

```bash
# Fedora
sudo dnf install -y libXxf86vm-devel libXcursor-devel libXrandr-devel \
    libXinerama-devel libXi-devel mesa-libGL-devel
# Debian/Ubuntu
sudo apt install -y libgl1-mesa-dev xorg-dev
```

## Install / uninstall

```bash
./betterdesk-support -install     # copy to per-user dir + enable autostart
./betterdesk-support -uninstall   # remove autostart + installed binary
```

## Portable usage

**Tarball / bare binary:** place an empty `portable` (or `.portable`) file next to
the binary; state is written to a `data/` folder beside it.

**AppImage:** no marker needed — the runtime sets `APPIMAGE` and state is stored
in `betterdesk-support-data/` next to the `.AppImage` file (the mount is read-only).

## Environment variables

| Variable | Effect |
|----------|--------|
| `BETTERDESK_AGENT_BRANDING` | Load branding from an external JSON file |
| `BETTERDESK_AGENT_DATA_DIR` | Force the state directory |
| `BETTERDESK_CDAP_TLS=1` | Use `wss://` for the CDAP gateway |
| `BETTERDESK_AGENT_INSECURE_TLS=1` | Skip TLS verification for help requests (self-signed test servers) |
