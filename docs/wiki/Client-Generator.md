# Client Generator

The **Client Generator** builds ready-to-deploy **RustDesk clients** with your BetterDesk server settings and optional branding baked in.

---

## What you get

Each generated client includes:
- **ID Server** and **Relay Server** addresses
- **Public key** from your BetterDesk server
- **API Server** URL (port 21121)
- Optional **custom application name** and icon/branding

End users install the client — no manual network configuration required.

---

## Quick start

1. Log in to the web panel as **admin** or user with generator permission
2. Open **Client Generator** (or **Generator** in the sidebar)
3. Select **platform**:
   - Windows (x64, x86, ARM64)
   - Linux (AppImage, deb, rpm)
   - Android (APK)
   - macOS (Intel, Apple Silicon)
4. Enter server details (auto-filled from Settings when available):
   - ID Server / Relay Server
   - API Server (`http://your-server:21121`)
   - Public key
   - Application name
5. Click **Generate** and download the artifact

---

## Deployment tips

| Scenario | Recommendation |
|----------|----------------|
| **Enterprise Windows** | MSI/NSIS + Group Policy or Intune |
| **Linux fleet** | deb/rpm via package manager |
| **Mobile** | Distribute APK via MDM; iOS uses standard RustDesk from store + QR |
| **Updates** | Regenerate when server key or hostname changes |

---

## Requirements

- Server must be reachable from client networks (ports 21116–21117, 21121)
- Generator runs on the panel — sufficient disk space for build artifacts
- Some platforms require build tools on the server (installed by panel/update flow)

---

## See also

- [[Client Setup|Client-Setup]] — manual RustDesk configuration
- [[TLS / SSL Certificates|TLS-SSL]] — use `https://` for API server when TLS enabled
- [Client Generator docs](https://github.com/UNITRONIX/BetterDesk/blob/main/docs/features/CLIENT_GENERATOR.md)
