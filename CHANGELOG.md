## [Unreleased]

### Changed
- _(none yet)_

---

## [3.0.5] — 2026-06-07

### Changed
- _(none yet)_

---

## [3.0.4] — 2026-06-07

### Changed
- _(none yet)_

---

## [3.0.3] — 2026-06-07

### Changed
- _(none yet)_

---

## [3.0.2] — 2026-06-07

### Changed
- _(none yet)_

---

# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [3.0.1] — 2026-06-07 — Security hardening (2026-04-26)

### Added
- **Czech console translation completed** — `web-nodejs/lang/cs.json` now contains Czech UI text instead of the previous English fallback content and has the correct `meta.lang` value. Community contribution by [Karel Lowprize K](https://github.com/lowprize) ([PR #133](https://github.com/UNITRONIX/BetterDesk/pull/133)).
- **RustDesk PRO group endpoint stubs** — `betterdesk-server/api/server.go` now exposes `GET /api/group`, `GET|POST /api/group/get`, and `GET /api/peers/list` returning the `{total, data, msg}` envelope expected by RustDesk Flutter clients. Without these endpoints the Flutter UI aborted device-list loading and never fell back to address-book mode. Idea credit: [progloto](https://github.com/progloto) ([PR #81](https://github.com/UNITRONIX/BetterDesk/pull/81)).
- **Catch-all 404 logging** — Both `betterdesk-server/api/server.go` (Go API) and `web-nodejs/server.js` (RustDesk-compatible API + main panel) now log unmatched routes with method, path, client IP, and User-Agent. Makes missing client-compatibility endpoints easy to spot during deployments. Diagnostics suggestion credit: [progloto](https://github.com/progloto) ([PR #81](https://github.com/UNITRONIX/BetterDesk/pull/81)).
- **Defensive list parsing in panel** — `web-nodejs/services/betterdeskApi.js` and `web-nodejs/public/js/devices.js` already accepted both `[…]` and `{ peers: […] }` shapes; this stays unchanged so admin UI works regardless of which endpoint envelope a future RustDesk version returns.

### Changed
- **Docker quick-start admin credential lookup** — README and `docker-compose.quick.yml` now point users to the secure `.admin_credentials` file shared with the console container instead of grepping logs that do not reliably contain the generated password. Documentation suggestion by [Karel Lowprize K](https://github.com/lowprize) ([PR #134](https://github.com/UNITRONIX/BetterDesk/pull/134)).

### Fixed
- **Live device-status updates on the Devices page** — The WebSocket status handler now updates the current device state array and visible status badge without referencing a stale `allDevices` variable. This was found while reviewing Rafael Monteiro's heartbeat/status contribution ([PR #35](https://github.com/UNITRONIX/BetterDesk/pull/35)).
- **RustDesk WSS rendezvous timeout behind reverse proxies** — The Go signal WebSocket endpoint now sends RustDesk-compatible empty binary keepalive frames and ignores empty keepalive replies from clients. This prevents `Rendezvous connection is timeout` after a successful WSS handshake when Nginx proxies `/ws/id` to port `21118`. Reported by [odixz](https://github.com/odixz) ([#144](https://github.com/UNITRONIX/BetterDesk/issues/144)).
- **RustDesk WSS peer cleanup after keepalive** — Empty RustDesk WebSocket keepalive replies now refresh the in-memory peer heartbeat, preventing the signal server from marking an active WSS peer offline after the 30-second cleanup window. Follow-up logs and retest by [odixz](https://github.com/odixz) ([#144](https://github.com/UNITRONIX/BetterDesk/issues/144)).

### Security
- **Brute-force protection on RustDesk client API** — `web-nodejs/routes/rustdesk-api.routes.js` now `await`s `authService.checkBruteForce(...)`. Previously the async result was treated as truthy/undefined, making the lockout effectively unenforceable on the RustDesk-compatible login route. (Audit finding #1, High)
- **TOTP login session fixation** — `web-nodejs/routes/auth.routes.js` regenerates the session via `req.session.regenerate(...)` after successful 2FA verification, mirroring the standard login flow. Previously the pre-2FA session ID was reused for the post-2FA authenticated session. Cookie name is unchanged; existing browser sessions continue to work. (Audit finding #2, Medium)
- **Audit endpoints now require explicit RBAC** — `betterdesk-server/api/server.go` wraps `GET /api/audit/events` and `GET /api/ws/events` in `requirePermission(auth.PermAuditView, ...)`. All built-in roles that previously consumed these endpoints (`super_admin`, `admin`, `server_admin`, `global_admin`, `operator`, `viewer`) already grant `audit.view` by default — no behavioural change for them. **Behavioural change:** the `pro` role no longer receives `200` from these endpoints (it never had `audit.view` in `DefaultRolePermissions`). If a deployment relied on this implicit access, grant `audit.view` explicitly via the role-permission overrides table. (Audit finding #3, Medium)
- **Generic 500 responses from Go auth handlers** — `betterdesk-server/api/auth_handlers.go` no longer leaks `err.Error()` strings on 9 internal-server-error paths (list/update/delete users, TOTP setup/confirm/disable, list/create/delete API keys). Full error detail is now logged server-side via `log.Printf`. Status codes and non-500 responses are unchanged. (Audit finding #4, Medium)

### Deferred
- Plaintext storage of RustDesk client access tokens (audit finding #5) and CSP `'unsafe-inline'`/`'unsafe-eval'` exceptions (audit finding #6) are intentionally **not** included in this batch. They require a phased rollout that would otherwise break existing installations or active client sessions. Tracked in [docs/security/LOGIN_API_SECURITY_AUDIT_2026-04-26.md](docs/security/LOGIN_API_SECURITY_AUDIT_2026-04-26.md#deferred-patches).

---

## [3.0.0] — 2026-06-07

### Fixed
- **SQLite auth.db upgrade crash (issue #158)** — Console startup no longer fails with `SqliteError: no such column: token_hash` on existing `auth.db` volumes. The `token_hash` column and index are now added before any index DDL runs; legacy access tokens are backfilled with SHA-256 hashes on first boot.
- **Docker image version display** — Container entrypoints and image labels now report **3.0.0** (via `BETTERDESK_IMAGE_VERSION` at build time).

### Changed
- **Docker quick-start default image tag** — `docker-compose.quick.yml` pins `ghcr.io/unitronix/betterdesk-{server,console}:3.0.0` instead of `3.0.0-alpha`.

---

## [3.0.0-alpha] — 2026-04-01

### Added
- **Organization & User Account System** — Multi-tenant organizations with owner/admin/operator/user roles (Go server + Node.js panel)
- **Organization REST API** — 18 endpoints for CRUD orgs, users, devices, invitations, settings, login
- **Client Organization Login** — `OrgLoginPanel.tsx` with server address + username/password
- **mDNS/DNS-SD Discovery** — Auto-discover BetterDesk servers on LAN (`_betterdesk._tcp`)
- **Desktop Widget UI Overhaul** — New window management, taskbar redesign, wallpaper picker with tabs
- **Chat 2.0** — Operator↔device group chat, E2E encryption (ECDH + AES-256-GCM), read receipts, file sharing, typing indicators
- **Web Remote File Transfer** — Browser-based bidirectional file transfer with drag-and-drop, progress tracking, resume, history
- **Security Hardening** — Organization-scoped policies (password, session, IP whitelist, device enrollment, 2FA, data retention)
- **Fleet Management** — Device groups with tags, batch operations (restart, update, lock, wipe), cascading deletion
- **Scaling Infrastructure** — Load balancer health checks, horizontal scaling config, region-aware relay selection
- **Cross-Platform Support** — Platform detection, feature matrix, capabilities API per OS/browser
- **Security Audit Module** — Built-in scanner with 8 check categories, compliance scoring, scheduled scans, PDF/JSON/CSV reports
- **i18n Expansion** — 25+ languages (auto-discovery), Language Management admin page, `i18n:check` script with `--fix` mode
- **Device Resource Control** — USB, optical drive, monitor, disk, quota policy management per device
- **CDAP Documentation** — Protocol spec, agent guide, bridge guide, API reference (5 docs)
- **SDK Documentation** — Python + Node.js SDK reference, integration examples, studio guide (5 docs)
- **Pre-Release Checklist** — 8-section validation checklist for releases
- **Docker SBOM + Trivy** — SBOM generation and vulnerability scanning in CI
- **6 New Console Languages** — German, Spanish, French, Italian, Dutch, Portuguese
- **3 High-Priority Languages** — Japanese, Korean, Chinese (Simplified)
- **12 Additional Languages** — Arabic, Hebrew, Ukrainian, Turkish, Hindi, Swedish, Norwegian, Danish, Finnish, Czech, Hungarian, Romanian, Thai, Vietnamese, Indonesian
- **Desktop Client i18n Framework** — `src/lib/i18n.ts` with `t()` function, plural forms, locale detection
- **NSIS Multilingual Installer** — 12 languages in NSIS language selector
- **Light Theme** — `themes/light.json` with WCAG-compliant light colors
- **Theme API** — `GET /api/settings/themes`, `POST /api/settings/themes/:id/apply`
- **Page Transition Animations** — `transitions.css` with page enter/exit, stagger, skeleton loading
- **GitHub Actions: Client Releases** — Multi-platform Tauri builds (Windows/Linux/macOS)
- **GitHub Actions: Server Releases** — Go cross-compile (linux-amd64/arm64, windows-amd64)
- **Security Documentation** — THREAT_MODEL.md, ENCRYPTION_SPEC.md, COMPLIANCE.md, AUDIT_LOG.md
- **Responsible Disclosure Policy** — `.github/SECURITY.md`
- **Web Remote Toolbar** — Scale mode selector, monitor switcher, clipboard sync, special keys menu
- **Fullscreen Mode** — F11 keyboard shortcut + button toggle
- **Bidirectional Clipboard** — `navigator.clipboard` API integration in remote viewer
- **Special Keys Menu** — Ctrl+Alt+Del, Win, PrintScreen, Alt+Tab, Alt+F4, Task Manager
- **Beta Banner** — Replaced WIP banner with slim dismissible beta indicator

### Changed
- **CSP Headers Hardened** — Added `frame-ancestors`, `worker-src`, `child-src`; expanded Permissions-Policy
- **X-Frame-Options** — Changed from `DENY` to `SAMEORIGIN` for desktop widget embed mode
- **WebSocket CSP** — Added `ws:` to `connect-src` for HTTP mode (was missing)
- **Cross-Origin Resource Policy** — Enabled `same-origin` (was disabled)

### Fixed
- **Chat: Tray opens wrong window** — Tray "Chat" now opens dedicated chat WebviewWindow directly
- **Chat: Shows "Disconnected"** — WebSocket URL now uses dynamic `ws://`/`wss://` based on console_url
- **Rust warnings** — All 10 compilation warnings fixed (unused imports, variables, labels)
- **Go warnings** — `go vet` clean, 0 issues

---

## [2.4.0] — 2026-03-21

### Added
- **PostgreSQL Support** — Full PostgreSQL database backend for Go server and Node.js console
- **SQLite → PostgreSQL Migration** — Built-in migration tool (menu option M/P)
- **CDAP v0.3.0** — Widget rendering, device detail page, REST API, 8 widget types
- **Native BetterDesk Agent** — Go binary for system management, 14 flags, 9 widgets
- **Bridge SDK** — Python + Node.js SDKs for CDAP bridges (Modbus, SNMP, REST)
- **Device Revocation** — `DELETE /api/peers/{id}?revoke=true&cascade=true`
- **Peer Metrics** — `peer_metrics` table, `GET /api/peers/{id}/metrics`
- **CDAP Audio** — Bidirectional audio streaming via WebSocket
- **Devices Page Redesign** — Horizontal folder chips, kebab menu, responsive layout
- **Docker GHCR** — Pre-built images on GitHub Container Registry

### Fixed
- **Empty UUID in Relay** — Generate UUID when `RequestRelay{uuid=""}` received
- **ForceRelay TCP UUID Mismatch** — Return `PunchHoleResponse` instead of `RelayResponse`
- **Docker Port 5000 Conflict** — Added `SIGNAL_PORT` env var, priority over `PORT`
- **PS1 RandomNumberGenerator Crash** — Replaced .NET 6+ method with .NET 4.x compatible
- **API TLS Breaking Clients** — Separated `--tls-api` flag from signal/relay TLS
- **PostgreSQL Config Lost on Update** — Added `preserve_database_config()` function
- **Auth.db Destroyed on Update** — Detect existing `.env` as UPDATE indicator
- **Address Book Sync** — Real `address_books` table replacing stub handlers
- **Settings Password** — Fixed snake_case vs camelCase field name mismatch

---

## [2.3.0] — 2026-02-17

### Added
- **CSRF Protection** — Double-submit cookie pattern with `csrf-csrf`
- **TOTP 2FA** — Two-factor authentication with `otplib`
- **RustDesk Client API** — Dedicated WAN-facing port 21121 with 7-layer security
- **Address Book Sync** — Full AB storage with `address_books` table
- **Operator Role** — Admin/operator role separation with different permissions
- **SSL Certificate Configuration** — New menu option C in installer scripts
- **Desktop Connect Button** — Connect to devices from browser via RustDesk URI handler

### Fixed
- **Session Fixation** — Session regeneration after login
- **Timing-Safe Auth** — Pre-computed dummy bcrypt hash for non-existent users
- **WebSocket Auth** — Session cookie required for upgrade
- **Web Remote Client** — 5 Critical, 2 High, 3 Low bugs fixed

---

## [2.2.0] — 2026-02-06

### Added
- **Node.js Console** — Express.js web console replacing Flask
- **Migration Tool** — Migrate between console types
- **Automatic Node.js Installation** — Installer detects and installs Node.js

---

## [2.1.0] — 2026-02-04

### Added
- **Go Server** — Single binary replacing hbbs + hbbr (~20K LOC)
- **ALL-IN-ONE Scripts** — `betterdesk.sh` + `betterdesk.ps1` + `betterdesk-docker.sh`
- **Automatic Mode** — `--auto` flag for non-interactive installation
- **SHA256 Verification** — Automatic checksum verification of binaries

---

[3.0.0]: https://github.com/UNITRONIX/BetterDesk/compare/v3.0.0-alpha...v3.0.0
[3.0.0-alpha]: https://github.com/UNITRONIX/BetterDesk/compare/v2.4.0...v3.0.0-alpha
[2.4.0]: https://github.com/UNITRONIX/BetterDesk/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/UNITRONIX/BetterDesk/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/UNITRONIX/BetterDesk/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/UNITRONIX/BetterDesk/releases/tag/v2.1.0
[3.0.1]: https://github.com/UNITRONIX/BetterDesk/compare/v3.0.0...v3.0.1
[3.0.2]: https://github.com/UNITRONIX/BetterDesk/compare/v3.0.1...v3.0.2
[3.0.3]: https://github.com/UNITRONIX/BetterDesk/compare/v3.0.2...v3.0.3
[3.0.4]: https://github.com/UNITRONIX/BetterDesk/compare/v3.0.3...v3.0.4
[3.0.5]: https://github.com/UNITRONIX/BetterDesk/compare/v3.0.4...v3.0.5
