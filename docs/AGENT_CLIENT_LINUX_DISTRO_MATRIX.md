# Agent Client — Linux distribution matrix

Validation targets for **betterdesk-agent-client** production readiness (Windows + Linux scope).

| Distribution | Package | Session | Status |
|--------------|---------|---------|--------|
| Debian 12 / Ubuntu 22.04+ | `.deb` | X11 + Wayland | Primary |
| Fedora 40+ / RHEL 9+ | `.rpm` | X11 + Wayland | Primary |
| openSUSE Leap / Tumbleweed | `.rpm` | X11 + Wayland | Primary |
| Arch Linux | AppImage | X11 + Wayland | AppImage fallback |
| Other rolling/stable | **AppImage** | X11 + Wayland | Universal fallback |

## Dependencies (runtime)

| Tool | Purpose |
|------|---------|
| `ffmpeg` | Screen capture + H.264/VP9/AV1 encode (VAAPI/NVENC/QSV when available) |
| `xdotool` | Remote input on X11 |
| `ydotool` + `ydotoold` | Remote input on Wayland |

Preflight in the agent Status panel (admin → Advanced) reports missing tools before operators connect.

## Install formats (Generator)

| Format | Use case |
|--------|----------|
| `.deb` | Debian/Ubuntu/Mint/Pop!_OS |
| `.rpm` | Fedora/RHEL/openSUSE |
| **AppImage** | Distros without native package or quick IT trials |
| `.tar.gz` portable | Manual deploy without package manager |
| `.msi` / NSIS | Windows installed / portable |

Build pipeline: `web-nodejs/services/agentClientBuildWorker.js` on the Linux console host.

## Acceptance checklist (per distro)

1. Install from Generator artifact → autostart entry present (`~/.config/autostart/` or XDG).
2. Tray icon after reboot; sidecar CDAP connected.
3. Supervised session → consent + overlay; unattended → no prompt.
4. Remote desktop ≥ 30 fps when GPU encoder available; software fallback otherwise.
5. AppImage runs on distro without `.deb`/`.rpm` after `chmod +x`.
