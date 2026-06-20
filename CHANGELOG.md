## [Unreleased]

### Changed
- _(none yet)_

---

## [3.3.49] — 2026-06-20

### Changed
- RustDesk mass-deployment docs and dashboard helpers for Intune/PSADT: correct `--config` deploy string format, editable client server address, **Copy deploy string** / **Intune script** on Dashboard, `PANEL_PUBLIC_HOST` env, and `scripts/deploy/rustdesk-apply-config.ps1.example` (#209).

---

## [3.3.48] — 2026-06-20

### Changed
- _(none yet)_

---

## [3.3.47] — 2026-06-20

### Changed
- _(none yet)_

---

## [3.3.46] — 2026-06-20

### Changed
- _(none yet)_

---

## [3.3.45] — 2026-06-20

### Changed
- _(none yet)_

---

## [3.3.44] — 2026-06-20

### Changed
- Hardened RustDesk client change-ID handling so only the active owner of the old ID can rename it, and soft-deleted device IDs remain reserved instead of being moved by client-side ID changes (#213).

---

## [3.3.43] — 2026-06-20

### Changed
- _(none yet)_

---

## [3.3.42] — 2026-06-20

### Changed
- _(none yet)_

---

## [3.3.41] — 2026-06-20

### Changed
- _(none yet)_

---

## [3.3.40] — 2026-06-20

### Changed
- _(none yet)_

---

## [3.3.39] — 2026-06-19

### Changed
- **Organization shared address book panel (#190):** the organization detail page now exposes the missing Address Book tab, including JSON editing, sharing toggle, and import from assigned org devices. Members still receive the shared contacts through RustDesk address book sync while personal entries remain private.

---

## [3.3.38] — 2026-06-18

### Changed
- _(none yet)_

---

## [3.3.37] — 2026-06-18

### Changed
- **Docker admin password seeding (#204):** `ADMIN_PASSWORD` now maps to the internal Go and Node.js first-run admin seed variables in quick-start, MACVLAN, and single-container Docker deployments. Existing admin accounts are still left unchanged on restart; use the password reset flow or fresh volumes to change an already-created admin.

---

## [3.3.36] — 2026-06-18

### Changed
- _(none yet)_

---

## [3.3.35] — 2026-06-18

### Changed
- _(none yet)_

---

## [3.3.34] — 2026-06-18

### Changed
- _(none yet)_

---

## [3.3.33] — 2026-06-18

### Changed
- _(none yet)_

---

## [3.3.32] — 2026-06-18

### Changed
- _(none yet)_

---

## [3.3.31] — 2026-06-18

### Changed
- _(none yet)_

---

## [3.3.30] — 2026-06-18

### Changed
- _(none yet)_

---

## [3.3.29] — 2026-06-18

### Fixed
- **Device ID reuse after deletion (#213):** changing a device ID to a value reserved by a soft-deleted peer now returns a clear conflict instead of a generic server error. The panel also explains that normal delete keeps the ID reserved and offers permanent deletion when an operator intentionally wants to release the ID for reuse.

### Changed
- _(none yet)_

---

## [3.3.28] — 2026-06-17

### Changed
- _(none yet)_

---

## [3.3.27] — 2026-06-17

### Fixed
- **Web Console CI / dependency audit:** bump `nodemailer`, `multer`, `ws`, and transitive `form-data` minimums so `npm audit --omit=dev --audit-level=high` passes on the release branch.

---

## [3.3.26] — 2026-06-17

### Changed
- _(none yet)_

---

## [3.3.25] — 2026-06-17

### Fixed
- **RustDesk client login with console 2FA (#203)** — console password changes now mirror to the Go user store, and SQLite installs mirror console TOTP enable/disable state into the Go `users` row used by `/api/login`. RustDesk clients should now receive the expected `email_check` / `tfa_check` challenge instead of `Invalid credentials` or password-only login when console 2FA is enabled. No TOTP bypass endpoint was added.

---

## [3.3.24] — 2026-06-17

### Fixed
- **Bare-metal console startup (#206)** — `betterdesk-console` failed with `SQLITE_READONLY_DIRECTORY` on `db_v2.sqlite3` because the unprivileged `betterdesk` user could not write to the Go server data directory. Installer and `linux-ensure-console-user.js` now apply setgid group-write on `$RUSTDESK_PATH`, re-sync permissions after the Go server starts, and verify both console `data/` and Go data dirs before marking permissions OK. **Verify:** `systemctl status betterdesk-console` is `active`; panel loads on port 5000 or 5443. Ships via Settings → Updates or `betterdesk.sh` update/repair.

### Changed
- _(none yet)_

---

## [3.3.23] — 2026-06-15

### Changed
- _(none yet)_

---

## [3.3.22] — 2026-06-14

### Added

- **RdClient desktop (production hardening):** server URL validation via `GET /api/bd/server-info` and `probe_server_url`; extended `config.json` (`tls_strict`, `ui_lang`, `discovered_via`); `BETTERDESK_SERVER_URL` env and embedded `betterdesk-rdclient.json` on first launch; LAN discovery (UDP port 21119 + optional mDNS `_betterdesk._tcp`); local **Settings** window (change URL, TLS, sign out, factory reset); peer **Remember device password** vault (IndexedDB AES-GCM per device); language switcher on `/remote/login`, dashboard, and viewer (26 locales); **Generator → RdClient desktop** bundles with `rdclientBuildWorker` (6 platform variants, embedded panel URL).

### Changed

- **RdClient codecs (Linux):** WebKitGTK skips unreliable AV1 negotiation; runtime fallback to VP9/H.264 on decode failure.
- **RdClient dashboard:** unified sidebar + device panel scrolling; desktop settings button in header.

### Manual steps (build host)

- RdClient installer builds require **Rust stable**, **npm**, **@tauri-apps/cli**, and Linux deps (`webkit2gtk4.1-devel`, `openssl-devel`, …) on the panel build host. Optional: `npm install bonjour-service` in `web-nodejs` for mDNS panel publish (`PANEL_MDNS=off` to disable).

---

## [3.3.21] — 2026-06-14

### Changed
- _(none yet)_

---

## [3.3.20] — 2026-06-14

### Fixed

- **RdClient dashboard (web):** address book and sidebar scroll inside fixed columns with hidden scrollbars; `.rd-desk-content` flex chain fixed so the device grid no longer stretches the window.
- **RdClient video (AV1):** WebKit uses software AV1 decode; agent `codec_string` is passed to `VideoDecoder`; AV1 keyframes build `description` (av1C); failed codecs auto-reconnect with VP9/H.264.
- **RdClient desktop:** **Connect** from the loaded `/remote` dashboard — runtime ACL for the configured panel origin (fixes LAN IP:port invoke), injected Connect bridge in the desktop shell (works before panel JS update), correct Tauri invoke args (`deviceId` / `deviceName`), and a new app window loading the same `/remote/:id` viewer as the web panel; session window **Back** closes the desktop window (injected handler + no `/devices` fallback).
- **RdClient desktop (performance):** Linux Wayland keeps WebKit DMA-BUF/GPU compositing enabled by default; vendor-specific VA-API (Intel `iHD`, AMD `radeonsi`, NVIDIA when `nvidia-vaapi-driver` is present); GStreamer hardware decoder rank for AV1/H264/VP9/H265; session windows disable background throttling; Windows WebView2 AV1/HEVC GPU decode flags; WebCodecs probes multiple AV1/H264 profiles for WebKitGTK compatibility.

### Changed
- _(none yet)_

---

## [3.3.19] — 2026-06-14

### Added

- **RdClient desktop (Phase C — MVP):** new `rdclient-desktop/` Tauri v2 operator shell — first-run panel URL setup, main window loads `{url}/remote`, **Connect** opens a separate session window (`/remote/:id`); web dashboard uses `open_session` when `__TAURI__` is present. **Linux:** automatic X11/Wayland session detection and WebKitGTK workarounds (Gdk error 71 on Wayland). **TLS:** accepts **HTTP** and **HTTPS** with self-signed, Let's Encrypt, or incomplete-chain certs (operator panels); set `BETTERDESK_TLS_STRICT=1` for strict system CA validation only. Not yet distributed via Settings → Updates (build from source).

### Changed
- _(none yet)_

---

## [3.3.18] — 2026-06-14

### Changed
- _(none yet)_

---

## [3.3.17] — 2026-06-14

### Added

- **RdClient dashboard (web):** **Tools → Remote Desktop** opens `/remote` in a new browser tab — standalone operator address book with folders, device groups, tags, quick-connect by ID, card grid (RustDesk-inspired layout), list toggle, 30s auto-sync, panel branding/fonts/colors. Devices → Web Remote unchanged.
- **RdClient login (web):** `/remote/login` — dedicated operator sign-in when the panel session expires (redirects to `/remote` or viewer instead of admin `/login`); optional **Remember me** stores encrypted credentials in IndexedDB (Web Crypto AES-GCM), separate from the peer password vault planned for Phase B.

### Changed
- _(none yet)_

---

## [3.3.16] — 2026-06-14

### Changed

- **Go server (performance):** batch peer lookup via `GetPeersByIDs` for address book merge and scoped RustDesk peer lists (avoids N+1 `GetPeer` queries on large fleets).
- **Go server (performance):** SQL pagination for admin `GET /api/peers?limit=&page=`; scoped RustDesk device groups reuse batched peer loading.
- **Go server (billing):** stale pending relay metadata is swept after 10 minutes when pairing never completes.
- **Go server (relay):** fix pairing race when both sides connect simultaneously (LoadOrStore instead of LoadAndDelete+Store).
- **Go server (signal):** two-phase `CheckHeartbeats` shortens peer-map write lock during heartbeat sweeps.
- **Go server (observability):** `/api/health` and `/metrics` expose live peer tiers, relay sessions, and billing pending relay count.

### Added

- **Go server (compat):** integration test covering signal relay assignment through hbbr byte relay (`TestSignalRelayWireFlow`).
- **Go server (tests):** relay pairing tests wait for `ActiveSessions` instead of a fixed sleep.
- **Go server (DB):** `ListPeersPaginated` / `ListPeersForOrgPaginated` for large fleet admin views.

---

## [3.3.15] — 2026-06-14

### Changed

- **Go server (stability):** CDAP disconnect cleans all session types (terminal, video, file, audio, desktop); batch peer status DB updates on mass offline; known-peer heartbeats skip registration rate limiter; relay WebSocket uses same per-IP ConnLimiter as TCP; Postgres query timeouts on status updates; org login rate limiting.
- **CI:** `go-server-ci.yml` runs `go vet` and `go test -race` on changes under `betterdesk-server/`.

---

## [3.3.14] — 2026-06-14

### Changed
- _(none yet)_

---

## [3.3.13] — 2026-06-14

### Changed
- _(none yet)_

---

## [3.3.12] — 2026-06-14

### Changed
- _(none yet)_

---

## [3.3.11] — 2026-06-14

### Changed
- _(none yet)_

---

## [3.3.10] — 2026-06-14

### Changed
- _(none yet)_

---

## [3.3.9] — 2026-06-14

### Added

- **Settings → Appearance (branding):** Modular studio layout with live preview panel, autosave, server-side appearance profiles, built-in theme gallery, Google Fonts picker (expanded catalog), custom font upload (woff2/ttf), and dynamic branding CSS at `/css/branding.css` (fixes theme overrides not applying when static `theme.css` took precedence).

### Changed

- **Appearance tab:** Changes apply without full page reload; optional “preview on this page” toggle; read-only mode when the user lacks `branding.edit`.

---

## [3.3.8] — 2026-06-14

### Changed
- _(none yet)_

---

## [3.3.7] — 2026-06-14

### Changed
- _(none yet)_

---

## [3.3.6] — 2026-06-14

### Added

- **Email notifications:** SMTP configuration moved to **Settings → Email** (host, credentials, from address, alert/warning email). Each panel user can have an **email address** in User Management (used for routing notifications).
- **Help request emails:** When a device submits a help request, operators assigned to the device **folder or device group** receive an email (configurable under **Commercialization → Advanced settings**). Falls back to the alert email when no operator address is available. Requires `nodemailer` (now a declared dependency).

### Changed

- **Automation:** SMTP tab removed; use **Settings → Email** instead. Legacy `/api/automation/smtp*` endpoints still proxy to the shared SMTP handlers for one release cycle.
- **Console layout:** Main content now uses the full workspace width (removed the 1400px cap on all panel pages). Device details open as a large workspace modal between the sidebar and the right edge instead of a 640px slide-over from the viewport edge.

---

## [3.3.5] — 2026-06-14

### Changed

- **License (stable):** **v3.4.0** will be the first stable release under **AGPL-3.0** (already in effect on `dev` since v3.3.3). v3.3.x and earlier remain Apache 2.0.

---

## [3.3.4] — 2026-06-14

### Changed
- _(none yet)_

---

## [3.3.3] — 2026-06-13

### Changed

- **License:** The project transitions to **AGPL-3.0** on the development branch. **v3.4.0** will be the first stable release under AGPL-3.0; **v3.3.x and earlier** remain under Apache 2.0. See [docs/COMMERCIAL-GRANT.md](docs/COMMERCIAL-GRANT.md) for sponsor terms.
- **i18n:** French (`fr.json`) and Traditional Chinese (`zh-TW.json`) translations were withdrawn and recreated by the maintainer under AGPL-3.0.

---

## [3.3.2] — 2026-06-12

### Changed
- _(none yet)_

---

## [3.3.1] — 2026-06-12

Patch release on `main`. Ships via **Settings → Updates** (Stable), `betterdesk.sh` option 2, or replace `betterdesk.sh` from tag `v3.3.1`.

### Fixed

- **`betterdesk.sh` syntax error on Linux (#199)** — removed orphan `fi` in `update_from_github()` (line 3405) that broke `./betterdesk.sh` on v3.3.0 fresh clone and after self-update.
- **Update via `betterdesk.sh` (#198)** — existing installs no longer show the misleading “Creating admin user” / PANEL LOGIN CREDENTIALS banner; post-update path runs console permission sync and `systemctl reset-failed` before restart; panel health check uses HTTPS/custom `PORT` (not hard-coded `:5000`).

### Upgrade notes

| Topic | Action |
|-------|--------|
| **Broken 3.3.0 script** | Update to 3.3.1+ or once: remove the extra `fi` at line 3405, or copy `betterdesk.sh` from tag `v3.3.1`, then re-run Update. |
| **Verify** | `bash -n ./betterdesk.sh`; after update: `systemctl is-active betterdesk-console`; log in with your existing admin password. |

---

## [3.3.0] — 2026-06-12

Stable production release on `main` (merged from `dev`). Ships via **Settings → Updates** on the **Stable** channel, or `betterdesk.sh` / `betterdesk.ps1` option 2 / `docker compose pull` for GHCR. Panel update creates a pre-update backup by default. No database migration or manual SQL step is required.

### Added

- **Organization shared address book (#190)** — admins maintain a shared contact list per organization (Organizations → Address Book). Entries merge into each member's RustDesk address book on `GET /api/ab` when sharing is enabled; personal entries stay private.
- **Organizations → Device Groups tab** — readout of device groups and user groups linked to the organization (`team_id`), with shortcuts to Devices → Groups and one-click org-scoped group creation.
- **Docker MACVLAN quick-start (#186)** — `docker-compose.quick.macvlan.yml` plus upgrade notes in [DOCKER_QUICKSTART.md](docs/docker/DOCKER_QUICKSTART.md). Uses `service_started` (not `service_healthy`) and `127.0.0.1` API/WS env when the console uses `network_mode: service:server`.
- **`betterdesk-show-admin-credentials` helper (#195)** — re-execs as `betterdesk` to read `.admin_credentials` on hardened images (`cap_drop: ALL`). Bundled in all Docker images; documented in README, install.sh, and Docker troubleshooting.

### Fixed

- **Stale update warning banner (#192)** — Settings → Updates no longer keeps showing stale `EACCES` errors after a successful external update (`betterdesk.sh`, `betterdesk.ps1`, `betterdesk-docker.sh`, or GHCR `docker compose pull`). Non-critical root-owned file failures are filtered; the banner clears when the installed SHA matches the target. Native install/update now copies `VERSION` into the console directory (Settings reads semver from `VERSION` or `package.json`).
- **CodeQL / security hardening** — OIDC discovery blocks private/link-local DNS; branding SVG/CSS multi-pass sanitization; same-origin restrictions on desktop iframe routes and `Utils.api()`; confined filesystem helpers; upload rate limits; type-safe device file API parsing. CodeQL config documents intentional exclusions.
- **Go server product version in Docker builds** — `BETTERDESK_PRODUCT_VERSION` build arg embeds semver in the Go binary (Settings → Server Information matches panel version after image update).

### Changed

- Alpha desktop clients (`betterdesk-mgmt`, `betterdesk-agent-client`) temporarily untracked from git to reduce Dependabot / CI noise.
- Version bump automation uses `scripts/bump-version.js --list-paths` (includes Go server VERSION files and MACVLAN compose).

### Upgrade notes (operators)

| Topic | Action |
|-------|--------|
| **Native / panel update** | Settings → Updates → Stable → Check for updates → Install. Allow Go server rebuild/restart when prompted. |
| **Docker** | `docker compose pull && docker compose up -d` after release; use `betterdesk-show-admin-credentials` instead of `cat` as root. |
| **MACVLAN (#186)** | Switch to `docker-compose.quick.macvlan.yml` or set `depends_on: service_started`, `DB_PATH=/app/data/db_v2.sqlite3`, `127.0.0.1` for API/WS. |
| **Stale update banner (#192)** | Update to 3.3.0+ or once: `rm -f <console-path>/data/.last_update_result.json` and restart console. |

---

## [3.2.20] — 2026-06-12

### Changed
- _(none yet)_

---

## [3.2.19] — 2026-06-12

### Changed
- _(none yet)_

---

## [3.2.18] — 2026-06-12

### Changed
- _(none yet)_

---

## [3.2.17] — 2026-06-12

### Fixed
- **Docker admin credential lookup (#195)** — `docker compose exec` as root could not read `.admin_credentials` (mode 0600) on hardened images (`cap_drop: ALL`). Added `betterdesk-show-admin-credentials` helper (re-execs as `betterdesk`); updated README, quick-start compose comments, `install.sh`, and Docker docs. Existing installs without the helper can use `docker compose exec -u betterdesk console …`.

### Changed
- _(none yet)_

---

## [3.2.16] — 2026-06-11

### Changed
- _(none yet)_

---

## [3.2.15] — 2026-06-11

### Changed
- _(none yet)_

---

## [3.2.14] — 2026-06-11

### Changed
- _(none yet)_

---

## [3.2.13] — 2026-06-11

### Changed
- _(none yet)_

---

## [3.2.12] — 2026-06-11

### Changed
- _(none yet)_

---

## [3.2.11] — 2026-06-11

### Changed
- _(none yet)_

---

## [3.2.10] — 2026-06-11

### Fixed
- **CodeQL / security scan hardening** — OIDC discovery fetch blocks private/link-local DNS targets; branding SVG/CSS sanitization uses stable multi-pass stripping; desktop iframe routes and client `Utils.api()` restricted to same-origin paths; confined filesystem helpers for backups/server file browser/i18n; unbiased password generation; upload rate limits on tickets/languages/file-transfer; type-safe device file API body parsing. CodeQL config excludes dev-only scripts and documents intentional RustDesk wire-protocol hashes.

### Changed
- _(none yet)_

---

## [3.2.9] — 2026-06-11

### Changed
- _(none yet)_

---

## [3.2.8] — 2026-06-11

### Changed
- _(none yet)_

---

## [3.2.7] — 2026-06-11

### Fixed
- **Stale update warning on script / Docker paths (#192)** — `betterdesk.ps1` and `betterdesk-docker.sh` now clear `data/.last_update_result.json` when syncing `.update_sha` after a successful external update (parity with `betterdesk.sh`). GHCR image deployments clear the same stale panel banner on console startup after `docker compose pull`.

### Changed
- _(none yet)_

---

## [3.2.6] — 2026-06-10

### Fixed
- **Docker MACVLAN quick-start (issue #186)** — Added `docker-compose.quick.macvlan.yml` and MACVLAN upgrade notes in `docs/docker/DOCKER_QUICKSTART.md`. Documents `service_started` (not `service_healthy`) and `127.0.0.1` API/WS env when the console uses `network_mode: service:server`.

### Changed
- _(none yet)_

---

## [3.2.5] — 2026-06-10

### Fixed
- **Panel update warning banner (#192)** — Settings → Updates no longer keeps showing stale `EACCES` errors after a successful `betterdesk.sh` update. Non-critical root-owned file failures (scripts, Dockerfiles, server source) are filtered out; the banner clears automatically when the installed SHA matches the update target.

### Changed
- _(none yet)_

---

## [3.2.4] — 2026-06-10

### Changed
- _(none yet)_

---

## [3.2.3] — 2026-06-10

### Added
- **Organization shared address book** — admins can maintain a shared contact list per organization (Organizations → Address Book tab). Entries are merged into each member's RustDesk address book on `GET /api/ab` when sharing is enabled. Personal address book entries remain private and editable only by the logged-in user. Fixes [#190](https://github.com/UNITRONIX/BetterDesk/issues/190).

### Changed
- **Organizations → Device Groups tab** — replaced the manual JSON address book editor with a readout of device groups and user groups linked to the organization (`team_id`). Includes a shortcut to Devices → Groups and a one-click “Create device group” action scoped to the org.

---

## [3.2.2] — 2026-06-10

### Changed
- _(none yet)_

---

## [3.2.1] — 2026-06-10

### Changed
- _(none yet)_

---

## [3.2.0] — 2026-06-10

### Changed
- _(none yet)_

---

## [3.1.15] — 2026-06-09

### Changed
- _(none yet)_

---

## [3.1.14] — 2026-06-09

Production release **3.2.0** (stable `main`). Ships via **Settings → Updates** on the **Stable** channel, or `betterdesk.sh` / `betterdesk.ps1` option 2. Panel update creates a pre-update backup by default. No database migration or manual SQL step is required.

### Security

- **CVE-2026-50575 / GHSA-3v82-3gf8-fxx8 (device replay after delete)** — WebSocket signal registration now rejects soft-deleted peer IDs (new registration and heartbeat), matching UDP/TCP. `UpdatePeerStatus` no longer marks soft-deleted rows `ONLINE`. Restoration is explicit only via `POST /api/peers/{id}/restore` or the Devices UI. Requires **`betterdesk-server`** update (panel rebuild/redeploy when Go sources change).
- **Dependency updates** — `go-ntlmssp` 0.1.1 (CVE-2026-32952), `golang.org/x/image` 0.38.0 (CVE-2026-33809), `pgx/v5` 5.9.2 in Go modules; `openssl` 0.10.80 and `tauri` 2.11.2 in Tauri `Cargo.lock` (**desktop client rebuild required** for Rust-side fixes; server/console panel update alone is not enough for desktop).
- **Go API proxy hardening** — shared `goApiProxy.js` validates path segments on fleet, commercialization, and cross-platform routes; ID guards on all proxy routes; blocks path-smuggling while accepting RustDesk peer IDs (`a-zA-Z0-9_-`).
- **Go API SSRF guard** — `goApiPath` validates relative paths on the `betterdeskApi` client; policy routes validate org/device IDs; help-request IDs validated before proxying to Go.
- **XSS** — `cross-platform.js`, `users.js`, `dataguard.js`, `cdap-studio.js` escape/sanitize dynamic HTML and CSS class names.
- **Path confinement** — shared `safePath` for backup deletion, i18n language files, server file browser, `fontService`, and `fileTransferService` (symlink-aware root checks). File browser respects `BETTERDESK_FILE_ALLOWED_ROOTS`.
- **SSRF / shell hardening** — OIDC discovery URLs validated before fetch; network monitor HTTP/TCP checks use validated hostname/port/path; terminal proxy restricted to known system shell paths; `updateService` and deploy helpers use `execFileSync` argv arrays; `linux-ensure-console-user.js` uses `execFileSync`.
- **Clear-text logging** — admin password no longer logged on first install; API login logs redact usernames (`logRedact.js`); admin self-test password cleared after use in `authService`.
- **Audit log** — `Recent` / `RecentByAction` clamp `n` to 500 to limit allocation.
- **CI** — `build.yml` default `permissions: contents: read`; write only on release/binary-update jobs.

### Fixed

- **RBAC** — deleting the last `super_admin` / legacy admin is blocked (HTTP 409), aligned with update/demotion guards; org owner label shown as **Org Admin** in all 26 locales.
- **Panel update (dev channel)** — repair step no longer re-downloads removed `web-nodejs/scripts/*` paths (404 false failures after dev-only i18n toolkit move).
- **Console update channel UX** — `Modal.confirm` for channel switch dialog; clearer Stable / Development labels and Docker update UI strings in all locales.
- **Go server deploy (Linux panel)** — privileged Go server binary deploy from the Linux panel (hotfix already on `main`).

### Added

- **One-line Linux installer (`install.sh`)** — `curl -fsSL …/install.sh | sudo bash` for automated Docker quick-start (engine install when missing, compose download with validation, relay IP detection, firewall rules, health wait, credential summary). Use `--native` for git clone + `betterdesk.sh --auto`, or `--uninstall` / `--purge` to tear down the Docker stack.

### Changed

- **i18n dev toolkit** moved to `web-nodejs/scripts/dev-i18n/` — not deployed to production consoles; one-shot `patch-*` scripts removed (recoverable from git history).
- **Update channel switcher** — stable vs development channel selection in Settings → Updates (production servers should stay on Stable).

### Upgrade notes (operators)

| Topic | Action |
|-------|--------|
| **Native / panel update** | Settings → Updates → Stable → Check for updates → Install. Allow Go server rebuild/restart when prompted. |
| **Docker** | Pull new GHCR tags after release (`docker compose pull && docker compose up -d`); in-app GitHub install is disabled in container mode. |
| **Soft-deleted devices** | Do not expect deleted peers to self re-register over WebSocket; use **Restore** in Devices if intentional. |
| **Custom file paths** | If file browser or font upload breaks, review `BETTERDESK_FILE_ALLOWED_ROOTS` in console `.env`. |
| **Desktop client (Tauri)** | Rebuild/reinstall desktop agent after this release to pick up `openssl` / `tauri` lockfile fixes. |
| **Rollback** | Use the automatic pre-update backup from Settings → Updates, or restore from your own snapshot. |

### Verify after update

1. Panel login and dashboard load.
2. Settings → Updates shows current version; no repair 404 errors.
3. Devices list and one test remote session.
4. Optional: delete-user guard — last admin cannot be removed (409).
5. Docker operators: confirm new image tag on GHCR matches `v3.2.0`.

---

## [3.1.13] — 2026-06-09

### Fixed
- **RBAC** — deleting the last `super_admin` is blocked (409), aligned with update/demotion guards; org owner label shown as Org Admin in all locales.
- **Panel update (dev channel)** — repair step no longer re-downloads removed `web-nodejs/scripts/*` paths (404 false failures).
- **Console update channel UX** — `Modal.confirm` for channel switch dialog; clearer stable/dev labels.

### Security
- **CVE-2026-50575 / GHSA-3v82-3gf8-fxx8 (device replay after delete)** — WebSocket signal registration rejects soft-deleted peer IDs; `UpdatePeerStatus` no longer marks soft-deleted rows `ONLINE`. Restoration via `POST /api/peers/{id}/restore` only. Ships via panel update (`betterdesk-server`).
- **Dependency updates** — `go-ntlmssp` 0.1.1 (CVE-2026-32952), `golang.org/x/image` 0.38.0 (CVE-2026-33809), `pgx/v5` 5.9.2; `openssl` 0.10.80 and `tauri` 2.11.2 in Tauri `Cargo.lock` (desktop client rebuild required for Rust-side fixes).
- **Go API proxy hardening (phases D–E)** — shared `goApiProxy.js` validates path segments on fleet, commercialization, and cross-platform routes; ID guards on all proxy routes; blocks path-smuggling while accepting RustDesk peer IDs.
- **Go API SSRF guard** — `goApiPath` validates all relative paths on `betterdeskApi` axios client; policy routes validate org/device IDs; help-request IDs validated before proxying.
- **XSS** — `cross-platform.js`, `users.js`, `dataguard.js`, `cdap-studio.js` escape/sanitize dynamic HTML and CSS class names.
- **Path confinement (CodeQL)** — shared `safePath` helper for backup deletion, i18n language files, server file browser, `fontService`, and `fileTransferService` (symlink-aware root checks).
- **SSRF / shell hardening** — OIDC discovery URLs validated before fetch; network monitor HTTP/TCP checks use validated components; terminal proxy restricted to known shell paths; `updateService` and deploy helpers use `execFileSync` argv arrays; `linux-ensure-console-user.js` uses `execFileSync`.
- **Clear-text logging** — admin password no longer logged on first install; API login logs redact usernames (`logRedact.js`); admin self-test password cleared after use.
- **Audit log** — `Recent` / `RecentByAction` clamp `n` to 500 to limit allocation (CodeQL).
- **CI** — `build.yml` default `permissions: contents: read`; write only on release/binary-update jobs.

### Changed
- **i18n dev toolkit** moved to `web-nodejs/scripts/dev-i18n/` — not deployed to production; one-shot `patch-*` scripts removed (recoverable from git history).
- **i18n** — Docker update UI strings and update-channel labels translated across all 26 locales.

---

## [3.1.12] — 2026-06-09

### Fixed
- **RBAC** — block deleting last `super_admin`; org owner label as Org Admin in all locales.

---

## [3.1.11] — 2026-06-09

### Security
- **Go API proxy hardening (phase E)** — shared `goApiProxy.js` validates path segments on fleet, commercialization, and cross-platform routes; blocks path-smuggling while accepting RustDesk peer IDs (numeric and `a-zA-Z0-9_-`).
- **Help-request API** — `betterdeskApi` validates registration help IDs before proxying to Go.
- **XSS** — `cross-platform.js`, `users.js`, `dataguard.js`, `cdap-studio.js` escape/sanitize dynamic HTML and CSS class names.
- **Audit log** — `Recent` / `RecentByAction` clamp `n` to 500 to limit allocation (CodeQL).
- **Clear-text logging** — admin self-test password cleared after use in `authService`.

### Changed
- _(none yet)_

---

## [3.1.10] — 2026-06-09

### Changed
- _(none yet)_

---

## [3.1.9] — 2026-06-09

### Changed
- _(none yet)_

---

## [3.1.8] — 2026-06-09

### Changed
- _(none yet)_

---

## [3.1.7] — 2026-06-09

### Security
- **Go API SSRF guard** — `goApiPath` validates all relative paths on `betterdeskApi` axios client; policy routes validate org/device IDs.
- **File browser** — directory listing uses `resolveChildPath` for each entry under an already-confined parent path.
- **Clear-text logging** — admin password no longer logged on first install; API login logs redacted usernames (`logRedact.js`).
- **Path confinement** — `fontService` and `fileTransferService` use `safePath.resolveChildPath` for filesystem operations.
- **CI** — `build.yml` default `permissions: contents: read`; write only on release/binary-update jobs.

### Changed
- _(none yet)_

---

## [3.1.6] — 2026-06-09

### Changed
- _(none yet)_

---

## [3.1.5] — 2026-06-09

### Fixed
- **Panel update (dev channel)** — after intentional removal of dev-only i18n scripts, the repair step no longer tries to re-download deleted `web-nodejs/scripts/*` paths (404 false failures).

### Security
- **Path confinement (CodeQL)** — shared `safePath` helper for backup deletion, i18n language files, and server file browser (symlink-aware root checks).
- **i18n dev toolkit** moved to `web-nodejs/scripts/dev-i18n/` (`apply-i18n-audit`, `i18n-audit-data/`, `collect-gap-keys`, `generate-gap-fill`) — not deployed to production; one-shot feature `patch-*` scripts removed (recoverable from git history).
- **SSRF hardening** — network monitor HTTP checks use `http.request` with validated hostname/port/path components.
- **Terminal proxy** — login shells restricted to known system shell paths.
- **Installer scripts** — `linux-ensure-console-user.js` uses `execFileSync` argv arrays instead of shell strings.
- **OIDC discovery** — HTTP fetch uses validated URL string after SSRF checks.

### Changed
- _(none yet)_

---

## [3.1.4] — 2026-06-09

### Changed
- _(none yet)_

---

## [3.1.3] — 2026-06-09

### Security
- **CVE-2026-50575 / GHSA-3v82-3gf8-fxx8 (device replay after delete)** — WebSocket signal registration now rejects soft-deleted peer IDs (new registration and heartbeat), matching the existing UDP/TCP path. `UpdatePeerStatus` no longer marks soft-deleted rows `ONLINE`. Restoration remains explicit via `POST /api/peers/{id}/restore` only. Ships via panel update (`betterdesk-server`).
- **Dependency updates (Dependabot)** — `go-ntlmssp` 0.1.1 (CVE-2026-32952), `golang.org/x/image` 0.38.0 (CVE-2026-33809), `pgx/v5` 5.9.2 in Go modules; `openssl` 0.10.80 and `tauri` 2.11.2 in Tauri `Cargo.lock` files (desktop client rebuild required for Rust-side fixes).
- **SSRF / path hardening (CodeQL)** — OIDC discovery URLs validated before fetch; language file routes confined to `lang/`; server file browser paths restricted to allowed roots (`BETTERDESK_FILE_ALLOWED_ROOTS`); network monitor TCP checks resolve DNS before connect; address-book tag merge capped to prevent allocation overflow.
- **Shell / logging hardening** — `updateService` and deploy helpers use `execFileSync` argv arrays; auth audit logs no longer echo operator usernames on sensitive paths; system log/stats routes rate-limited.

---

## [3.1.2] — 2026-06-08

### Added
- **One-line Linux installer (`install.sh`)** — `curl -fsSL …/install.sh | sudo bash` performs a fully automated Docker quick-start (Docker engine install when missing, compose download with validation, relay IP detection, firewall rules, health wait, credential summary). Use `--native` for git clone + `betterdesk.sh --auto`, or `--uninstall` / `--purge` to tear down the Docker stack.

---

## [3.1.1] — 2026-06-08

### Changed
- _(none yet)_

---

## [3.1.0] — 2026-06-07

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
[3.1.0]: https://github.com/UNITRONIX/BetterDesk/compare/v3.0.1...v3.1.0
[3.1.1]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.0...v3.1.1
[3.1.2]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.1...v3.1.2
[3.1.3]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.2...v3.1.3
[3.1.4]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.3...v3.1.4
[3.1.5]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.4...v3.1.5
[3.1.6]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.5...v3.1.6
[3.1.7]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.6...v3.1.7
[3.1.8]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.7...v3.1.8
[3.1.9]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.8...v3.1.9
[3.1.10]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.9...v3.1.10
[3.1.11]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.10...v3.1.11
[3.1.12]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.11...v3.1.12
[3.1.13]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.12...v3.1.13
[3.1.14]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.13...v3.1.14
[3.1.15]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.14...v3.1.15
[3.2.0]: https://github.com/UNITRONIX/BetterDesk/compare/v3.1.15...v3.2.0
[3.2.1]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.0...v3.2.1
[3.2.2]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.1...v3.2.2
[3.2.3]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.2...v3.2.3
[3.2.4]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.3...v3.2.4
[3.2.5]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.4...v3.2.5
[3.2.6]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.5...v3.2.6
[3.2.7]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.6...v3.2.7
[3.2.8]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.7...v3.2.8
[3.2.9]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.8...v3.2.9
[3.2.10]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.9...v3.2.10
[3.2.11]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.10...v3.2.11
[3.2.12]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.11...v3.2.12
[3.2.13]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.12...v3.2.13
[3.2.14]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.13...v3.2.14
[3.2.15]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.14...v3.2.15
[3.2.16]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.15...v3.2.16
[3.2.17]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.16...v3.2.17
[3.2.18]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.17...v3.2.18
[3.2.19]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.18...v3.2.19
[3.2.20]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.19...v3.2.20
[3.3.0]: https://github.com/UNITRONIX/BetterDesk/compare/v3.2.20...v3.3.0
[3.3.1]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.0...v3.3.1
[3.3.2]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.1...v3.3.2
[3.3.3]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.2...v3.3.3
[3.3.4]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.3...v3.3.4
[3.3.5]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.4...v3.3.5
[3.3.6]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.5...v3.3.6
[3.3.7]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.6...v3.3.7
[3.3.8]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.7...v3.3.8
[3.3.9]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.8...v3.3.9
[3.3.10]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.9...v3.3.10
[3.3.11]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.10...v3.3.11
[3.3.12]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.11...v3.3.12
[3.3.13]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.12...v3.3.13
[3.3.14]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.13...v3.3.14
[3.3.15]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.14...v3.3.15
[3.3.16]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.15...v3.3.16
[3.3.17]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.16...v3.3.17
[3.3.18]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.17...v3.3.18
[3.3.19]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.18...v3.3.19
[3.3.20]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.19...v3.3.20
[3.3.21]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.20...v3.3.21
[3.3.22]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.21...v3.3.22
[3.3.23]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.22...v3.3.23
[3.3.24]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.23...v3.3.24
[3.3.25]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.24...v3.3.25
[3.3.26]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.25...v3.3.26
[3.3.27]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.26...v3.3.27
[3.3.28]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.27...v3.3.28
[3.3.29]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.28...v3.3.29
[3.3.30]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.29...v3.3.30
[3.3.31]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.30...v3.3.31
[3.3.32]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.31...v3.3.32
[3.3.33]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.32...v3.3.33
[3.3.34]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.33...v3.3.34
[3.3.35]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.34...v3.3.35
[3.3.36]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.35...v3.3.36
[3.3.37]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.36...v3.3.37
[3.3.38]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.37...v3.3.38
[3.3.39]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.38...v3.3.39
[3.3.40]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.39...v3.3.40
[3.3.41]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.40...v3.3.41
[3.3.42]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.41...v3.3.42
[3.3.43]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.42...v3.3.43
[3.3.44]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.43...v3.3.44
[3.3.45]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.44...v3.3.45
[3.3.46]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.45...v3.3.46
[3.3.47]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.46...v3.3.47
[3.3.48]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.47...v3.3.48
[3.3.49]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.48...v3.3.49
