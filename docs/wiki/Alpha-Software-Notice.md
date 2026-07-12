# ⚠️ Alpha Software Notice

> **Last updated:** 2026-04-15

Both the **BetterDesk MGMT Client** and **BetterDesk Agent Client** are in early alpha (v1.0.0). They are under active development and **should not be used in production environments**.

---

## Component Readiness Matrix

| Component | Version | Status | Production Use |
|-----------|---------|--------|----------------|
| **Go Server** | v2.4.0 | ✅ Stable | ✅ Recommended |
| **Web Console (Node.js)** | v2.4.0 | ✅ Stable | ✅ Recommended |
| **Native CDAP Agent (Go)** | v1.0.0 | ✅ Stable | ✅ OK for deployment |
| **MGMT Client (Tauri)** | v1.0.0-alpha | ⚠️ Alpha | ❌ Do NOT use in production |
| **Agent Client (Tauri)** | v1.0.0-alpha | ⚠️ Alpha | ❌ Do NOT use in production |

---

## BetterDesk MGMT Client — Known Limitations

The MGMT Client is an operator/admin desktop app (Tauri v2 + SolidJS + Rust). The following features are incomplete or unstable:

- **Remote desktop** — Basic streaming works but the H.264/VP9 codec pipeline is not stable in all network conditions
- **Token management** — JWT refresh may fail on long sessions, requiring re-login
- **Device management** — Bulk actions, advanced filtering, and some context menu operations are not yet implemented
- **Chat** — E2E encryption is implemented but the connection may drop in certain network scenarios
- **File transfer** — The UI exists but large file transfer via the binary protocol is incomplete
- **CDAP integration** — Widget rendering and command execution work but are not fully tested across all device types
- **Cross-platform** — Only Windows builds (MSI/NSIS) are currently available; Linux and macOS are planned but not yet built
- **Server panel** — Admin operations work but may not reflect changes in real-time

### What works well

- Server connection and operator authentication (including TOTP 2FA)
- Device list with live status indicators
- Help request management (inbox, accept & connect)
- Server management panel (admin only)
- Notification center with type filtering
- mDNS LAN server discovery
- Session history viewing

---

## BetterDesk Agent Client — Known Limitations

The Agent Client is a lightweight endpoint agent (Tauri v2 + SolidJS + Rust). The following features are incomplete or unstable:

- **Remote access support** — Screen sharing and remote control input injection are not yet implemented
- **Administrative automation** — Script execution, policy deployment, and operator-tasked jobs are in early stages
- **Security hardening** — Mutual auth, certificate pinning, and advanced process hardening are not yet complete
- **Cross-platform** — Only Windows installer (NSIS) is available; Linux and macOS builds are planned
- **Service mode** — Background service via NSSM works but may not survive all upgrade scenarios gracefully
- **Config sync** — Server-pushed configuration updates may not apply until agent restart

### What works well

- Setup wizard with 5-step server validation and registration
- Device identity generation with OS keyring storage
- System info collection and heartbeat reporting
- Tray icon with autostart on login
- Help request submission (4-state flow)
- Basic chat with operators
- Settings panel (connection, privacy, general, about)

---

## What to Use in Production

For production environments, the recommended stack is:

1. **BetterDesk Go Server** — Fully production-ready signal/relay/API server
2. **BetterDesk Web Console (Node.js)** — Stable admin panel with full device management, RBAC, organizations, TOTP 2FA
3. **Standard RustDesk Client** — For remote desktop connections (fully compatible with BetterDesk server)
4. **Native CDAP Agent (Go)** *(optional)* — For headless servers and IoT devices that need telemetry and remote commands

This combination provides full functionality without relying on any alpha components.

---

## When Will These Clients Be Production-Ready?

There is no fixed timeline. Both clients are being actively developed. Progress is tracked in the [GitHub Issues](https://github.com/UNITRONIX/BetterDesk/issues) and the project's `copilot-instructions.md` changelog.

When the clients reach **beta** status, this notice will be updated accordingly.

---

## Reporting Issues

If you test the alpha clients and encounter bugs, please report via [GitHub Issues](https://github.com/UNITRONIX/BetterDesk/issues) with:

- Client name and version (e.g., "MGMT Client 1.0.0-alpha")
- Operating system and version
- Steps to reproduce the issue
- Screenshots or error logs
- Server version (Go server + Node.js console)

---

## See also

- [[Desktop Clients|Desktop-Clients]] — component comparison
- [[Web Console|Web-Console]] — stable production alternative
- [[Home]] — production vs alpha table
