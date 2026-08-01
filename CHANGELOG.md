## [Unreleased]

### Fixed
- **Dashboard Copy deploy string with invalid/placeholder public key (#340):** client config / deploy string / QR now require a valid Ed25519 key (base64 → 32 bytes), reject placeholders, and fall back to the live Go `GET /api/server-key` when `id_ed25519.pub` is missing or bad. Windows installer also sets `PUB_KEY_PATH` in the console NSSM environment. Ships via panel update (re-run `betterdesk.ps1` service setup to refresh NSSM env on Windows).

### Changed
- **Runtime EOL refresh:** Docker/CI/installers use **Node.js 24 LTS** (`engines` ≥22); Go build images **golang:1.26-alpine**; server runtime **alpine:3.22**. Patch bumps for console (`axios`, `nodemailer`, `ws`, `pg`) and Go modules (incl. `modernc.org/sqlite`). SNMP bridge depends on **`pysnmp` ≥7.1** (replaces `pysnmplib`). See `docs/development/DEPENDENCY_UPGRADE_BACKLOG.md` for deferred Express 5 / native majors.

### Docs
- Refreshed `docs/architecture/PROJECT_STRUCTURE.md` for the current Go + Node layout; dependency upgrade backlog added.

---

## [3.5.2] — 2026-07-31

### Changed
- _(none yet)_

---

## [3.5.1] — 2026-07-31

### Changed
- _(none yet)_

---

## [3.5.0] — 2026-07-31

### Added
- **Optional UX 3.5 console shell (Beta):** full-list sidebar + topbar chrome available via navbar switch (BETA badge) or `?ui=ux35`. **Classic icon rail remains the default and supported production UI.** Docs: `docs/wiki/UX-3.5.md`. Ships via panel update.
- **FreeBSD (Tier 3 / community):** example `rc.d` scripts and install notes under `contrib/freebsd/`. Refs #310. Manual build only — no CI FreeBSD binaries or panel updater support.

### Changed
- Dual-mode console chrome: operators who never switch stay on classic; UX 3.5 is explicitly labeled Beta while active (topbar chip). Escape hatch to classic unchanged.
- Includes prior stable 3.4.1–3.4.3 hotfixes for operators updating from older stables in one step (#302 enrollment outbound hardening, #313 Web Remote panel-proxy, OIDC `user.info`, mesh cert hash, Unban kebab, and related fixes already on `main`).

### Fixed
- **OIDC client login stuck on "Waiting…" (#304):** panel proxies `GET /api/auth/oidc/callback` (and `/api/oidc/callback`) to the Go API so Redirect URLs on the console origin complete RustDesk SSO. Ships via panel update.
- **Docker AIO supervisord crash on missing NTP/billing env (#299):** entrypoint/Dockerfile default `NTP_SERVERS` and billing clock vars. Ships via image rebuild / `docker compose pull`.
- **Rate limiter API path resolution:** more accurate path matching for console API rate limits. Ships via panel update.

### Docs
- UX 3.5 Beta dual-mode: `docs/wiki/UX-3.5.md`
- FreeBSD community notes: `contrib/freebsd/`

---

## [3.4.15] — 2026-07-31

### Changed
- **UX 3.5 labeled Beta (opt-in):** classic console remains the default shell. The navbar switch to UX 3.5 shows a **BETA** badge/tooltip; while UX 3.5 is active a small BETA chip appears in the topbar. Escape hatch back to classic is unchanged. Ships via panel update.

### Fixed
- _(none yet)_

---

## [3.4.14] — 2026-07-31

### Changed
- _(none yet)_

### Fixed
- _(none yet)_

---

## [3.4.3] — 2026-07-30


### Changed
- **Client Configuration public key masked by default (#319):** Dashboard and Keys page show the KEY as bullets until revealed via an eye toggle; Copy still pastes the raw key. Ships via panel update.
- **Docker update channel (#299):** Settings → Updates cannot switch stable/dev for GHCR image installs; use `BETTERDESK_IMAGE_TAG=latest` or `dev`, then `docker compose pull && up -d`. Panel shows a clear note; API returns `DOCKER_IMAGE_CHANNEL`.

### Fixed
- **OIDC client stuck on “Waiting account auth” (#326, #304):** `rustdeskUserPayload` now includes `user.info` (required by RustDesk 1.4.x serde). Callback could succeed while auth-query JSON was ignored. Ships via panel update (Go API restart).
- **Viewer-only outbound “ID not found” with service stopped (#327):** TCP `RegisterPk` binds peer IP for `FindByIP`; punch/relay also accepts a valid BetterDesk client login token. Anonymous initiators stay blocked (#302). Ships via panel update (Go signal restart).
- **Enrollment outbound gate hardening (#302):** reject initiators that still have `pending_device_<id>` even if a peers row exists. Ships via panel update (Go signal restart).
- **Web Remote SignedId MITM check + stale server key (#313):** viewer reads `id_ed25519.pub` on each page render (no empty cache if Go starts later); RdClient accepts base64 Key (and hex) and verifies `RelayResponse.pk` with the server key then `SignedId` with the peer identity key (RustDesk chain). Does not change the 3.4.2 panel-proxy allowlist. Ships via panel update. Note: desktop client `Failed to secure tcp: Signature mismatch in key exchange` when the Key field is empty/wrong is expected client config — set Key from Keys page / `id_ed25519.pub`.
- **Cannot delete seed `admin` with false UI success (#315):** panel delete now checks Go Super Admin parity on dual-SQLite, mirrors delete before local removal, and returns 409/502 instead of success when Go refuses last-admin (no silent backfill restore). Last–Super Admin guard and installer `reset-password.js` / menu reset (username `admin`) are unchanged. Ships via panel update.
- **Native install TLS self-signed deploy (#325):** `_safe_cp_tls_file` no longer deletes `betterdesk.crt` when source and dest are the same real file (self-signed generated in place). Symlink→copy for Let's Encrypt (#219) is unchanged. Ships via installer / `betterdesk.sh` (not panel-only). Verify: `install.sh --native` completes past “Generating self-signed TLS certificates” with both `/opt/betterdesk/ssl/betterdesk.crt` and `.key` present.
- **Enrollment Requests UI (#320):** search icon no longer overlaps the placeholder; row dividers stay continuous under Platform/Actions (`display:flex` moved off `<td>`); Platform/Version/Status/Requested/Actions columns centered. Ships via panel update.
- **MeshAgent `bad web cert hash` behind reverse proxy (#321):** PEM-aware `WebCertHash` (first `CERTIFICATE` SPKI SHA-384) and optional `MESH_WEB_CERT_FILE` for the public TLS cert agents see (e.g. NPM Let's Encrypt), independent of Go `TLS_CERT`. Ships via panel update (Go restart). Verify: mount LE fullchain → set `MESH_WEB_CERT_FILE` → agent registers without web-hash mismatch.
- **Devices kebab Unban called Ban (#323):** kebab menu passed boolean `device.banned` while the handler only treated the string `'true'` as banned, so Unban opened the Ban modal and POSTed `/ban`. Both boolean and dataset string are accepted now. Ships via panel update.
- **Client Configuration light theme contrast (#319):** replaced hardcoded dark `rgba(13,17,23,…)` panels with theme tokens (`--bg-tertiary` / `--bg-secondary`) so labels and endpoints stay readable in Light Theme. Ships via panel update.

### Docs
- **Caddy WebSocket Mode (#294):** client must use WSS (not `ws://` → HTTP 308); `TRUST_PROXY` / `TRUSTED_PROXIES` for correct peer IP after `/ws/id` upgrade. See `docs/setup/REVERSE_PROXY.md`.
- **Docker channel vs image tag (#299):** documented in `docs/docker/DOCKER_QUICKSTART.md`.

---

## [3.4.13] — 2026-07-28

### Changed
- _(none yet)_

### Fixed
- **npm audit (`brace-expansion`):** override bumped to `^5.0.8` (GHSA-mh99-v99m-4gvg) so Web Console CI `npm audit --omit=dev` passes (synced from stable 3.4.2).

---

## [3.4.12] — 2026-07-26

### Changed
- **UX 3.5 solid shell (performance):** glass/blur disabled in UX 3.5 chrome and content; opaque surfaces only. Classic shell glass branding unchanged. Ships via panel update.

### Fixed
- **UX 3.5 sidebar fonts jumping on Settings/Updates:** branding live preview no longer writes `--font-family` to `:root`; preview runs only on the Branding tab; chrome uses isolated `--ux35-font-chrome`.
- **UX 3.5 theme toggle lag:** topbar dark/light now applies a full solid token set immediately and reconciles `branding.css` on load (no longer waits for a second click).

---

## [3.4.11] — 2026-07-26

### Changed
- **UX 3.5 shell performance:** smoother sidebar resize (pointer capture + rAF, defer localStorage, disable glass blur while dragging), lighter page cards (no `backdrop-filter`), and cleaner tablet/phone drawer overlay fade. Ships via panel update.

---

## [3.4.10] — 2026-07-26

### Changed
- _(none yet)_

---

## [3.4.9] — 2026-07-26

### Added
- **FreeBSD (Tier 3 / community):** example `rc.d` scripts and install notes under `contrib/freebsd/`; documented in README platform table and wiki Installation. Refs #310. Manual build only — no CI FreeBSD binaries or panel updater support yet.

### Fixed
- **Docker AIO supervisord crash on missing NTP/billing env (#299):** entrypoint and Dockerfile now default `NTP_SERVERS` and billing clock vars so Portainer / bare `docker run` / incomplete stacks no longer fail with `ENV_NTP_SERVERS` cannot be expanded. Also fixed corrupted `ENV ENCRYPTED_ONLY=1\nENV RELAY_SERVERS=` (was `ENCRYPTED_ONLY=1nENV` in the image).
- **Web Remote broken after enrollment outbound gate (#302):** PunchHole/RequestRelay from the panel `/ws/rendezvous` proxy (default loopback CIDRs via `PANEL_SIGNAL_PROXY_CIDRS`) are accepted again without requiring a registered RustDesk peer. Unapproved clients and anonymous public initiators remain blocked. Ships via panel update (Go signal restart).

---

## [3.4.8] — 2026-07-26

### Changed
- _(none yet)_

---

## [3.4.7] — 2026-07-26

### Changed
- **Console chrome dual mode:** default UI is again the classic icon rail + flyout. **UX 3.5** is available via a navbar/topbar switch (cookie `bd_ui_shell`, or `?ui=classic|ux35`). Docs: `docs/wiki/UX-3.5.md`. Ships via panel update.

### Fixed
- **UX 3.5 light theme only recolored the blue topbar:** built-in light/dark palettes in `generateThemeCss()`, `ui-polish.css` on console layout, theme toggle persists palette + glass.
- **UX 3.5 settings / main content invisible under branding wallpaper:** `.ux35-shell { position:relative; z-index:1 }` and branding background CSS includes `.ux35-shell` / `.ux35-content`.

---

## [3.4.6] — 2026-07-26

### Changed
- _(none yet)_

---

## [3.4.5] — 2026-07-26

### Changed
- _(none yet)_

---

## [3.4.4] — 2026-07-26

### Added
- **UX 3.5 default console shell:** native full-list sidebar + topbar (promoted from retired Beta 3.1), glass branding, Dark/Light/Custom themes in Settings → Branding, resizable sidebar, tablet/phone drawer. Login / RdClient / remote viewer unchanged. Docs: `docs/wiki/UX-3.5.md`. Ships via panel update.

### Fixed
- **UX 3.5 light theme only recolored the blue topbar:** `branding.css` kept emitting saved dark palette colors, and `ui-polish.css` was not loaded on the console layout — so body/sidebar text stayed light-on-dark. Light/Dark now resolve built-in palettes in `generateThemeCss()`, glass defaults follow the mode, and the topbar theme toggle persists the matching palette.
- **UX 3.5 settings / main content invisible under branding wallpaper:** console wallpaper uses `body.app-page::before` at `z-index:0` while the old shell raised `.app-layout` to `z-index:1`. UX 3.5’s `.ux35-shell` had no stacking context, so the black wallpaper covered page text (sidebar/topbar still showed via their own z-index). `.ux35-shell` is now `position:relative; z-index:1` and branding background CSS includes `.ux35-shell` / `.ux35-content`.

### Changed
- **Console chrome:** TeamViewer-style rail/flyout and Desktop Mode are no longer loaded as the management UI; UX 3.5 is the single console interface on `dev`.

---

## [3.4.3] — 2026-07-25

### Fixed
- **OIDC client login stuck on “Waiting…” (#304):** panel now proxies `GET /api/auth/oidc/callback` (and `/api/oidc/callback`) to the Go API, so Redirect URLs that use the console origin (`:5000` / `:5443`) complete RustDesk SSO instead of returning 404. Settings also validate the callback path and clarify the hint. Ships via panel update. Verify: IdP Redirect URL = `https://<panel>/api/auth/oidc/callback` → SSO in RustDesk finishes with access token (browser shows success page).

### Changed
- _(none yet)_

---

## [3.4.2] — 2026-07-28

### Fixed
- **Web Remote broken after enrollment outbound gate (#313, #302):** PunchHole/RequestRelay from the panel `/ws/rendezvous` proxy (default loopback CIDRs via `PANEL_SIGNAL_PROXY_CIDRS`) are accepted again without requiring a registered RustDesk peer. Unapproved clients and anonymous public initiators remain blocked. Ships via panel update (Go signal restart). Native/all-in-one needs no env change; Docker split console↔server must set `PANEL_SIGNAL_PROXY_CIDRS` to the console CIDR if still denied.
- **npm audit (`brace-expansion`):** override bumped to `^5.0.8` (GHSA-mh99-v99m-4gvg) so Web Console CI `npm audit --omit=dev` passes on stable.

### Changed
- _(none yet)_

---

## [3.4.1] — 2026-07-25

### Fixed
- **`betterdesk.sh` Online GitHub update leaves Console inactive (#306):** `start_services_with_verification` no longer aborts under `set -e` when `sqlite3` API-key sync fails after Go start; Console always gets `systemctl start`/`restart`, and update no longer prints success when `betterdesk-console` is not Active. Ships via installer script / next stable hotfix (not panel-only). Verify: Update → Online update from GitHub → `systemctl is-active betterdesk-console` is `active` without a manual start.

### Changed
- _(none yet)_

---

## [3.4.0] — 2026-07-24

### Added
- **OIDC login for stock RustDesk desktop clients (#304):** when panel OIDC is enabled, RustDesk Login shows an SSO option (`/api/login-options` + `/api/oidc/auth` / `auth-query`, same IdP config as panel SSO). Ships via panel update (Go API restart). Verify: enable OIDC → client SSO button → IdP login → access token.
- **Guest Access Links for Web Remote / RdClient (#274):** time-limited opaque links with a device allowlist; guests open `/remote/guest?t=…` without a Console session. Mesh single-device share tunnel auth works with a valid `mesh_share` token.
- **RustDesk client LDAP/AD login (#218, #260):** desktop/mobile clients use the same directory auth as the web console. Operator guide: `docs/wiki/LDAP-AD.md`.
- **RustDesk client sessions (#242):** DB-backed tokens (default 7 days, sliding renewal, max 30 days) under Settings → Authentication → RustDesk clients.
- **MeshCentral compatibility layer:** optional `MESH_ENABLED=Y` — native Go `/agent.ashx` / `/meshrelay.ashx` / `/control.ashx`, inventory, guest share, port relay, recording. See `docs/features/MESHAGENT_ONBOARDING.md`.
- **BetterDesk Agent Client (alpha):** new Tauri enrollment / remote-agent client tree (`betterdesk-agent-client/`).
- **Update channel:** Stable (`main`) vs Development (`dev`) in Settings → Updates (and installer scripts).

### Fixed
- **WebSocket Mode behind Nginx / reverse proxy (#276):** signal WSS no longer builds session keys as `IP:0` from proxied headers; PunchHole/RelayResponse reaches WebSocket initiators. **Manual:** set `TRUST_PROXY=Y` and `TRUSTED_PROXIES=<proxy CIDR>`, restart Go, use IP-only `X-Real-IP`, confirm logs show `effective=<client-ip>:<non-zero-port>`.
- **WSS relay decryption / mixed protocol (#293, #290):** complete WS message forwarding (no 32 KiB split); reject mixed WSS + native TCP/TLS relay pairs.
- **Fresh Docker / GHCR install (#299):** image tag sync, credentials helpers, `DB_PATH` for split compose, `su-exec` / UID `betterdesk` for auth.db under `cap_drop: ALL`.
- **PostgreSQL client login and user sync (#300, #301, #292):** session `created_at` scan, duplicate-user loop, NULL `totp_secret` / `last_login` handling.
- **OIDC panel SSO authorize redirect (#298):** browser goes to the IdP, not the internal Go API URL.
- **Linux HTTP/HTTPS protocol toggle (#219):** LE cert copy (not symlink), bind-service / port sync, installer re-exec after update, Go `GO_API_PORT` / signal port isolation.
- **Web Remote file transfer (#217)** and related RdClient / Web Remote UX (toolbar, monitors, keyboard modes, session picker).
- **Default admin bootstrap:** remove illegal reassignment of `const password` after create (would TypeError on first-run admin creation).

### Security
- **Trusted proxy allowlist (#276):** honor `X-Real-IP` / `X-Forwarded-For` only when `TRUST_PROXY=Y` and the direct peer is in `TRUSTED_PROXIES` (empty allowlist ignores forwarded headers).
- **Enrollment outbound gate (#302):** PunchHole/RequestRelay require a live registered initiator; in managed/locked modes the peer must be approved (pending enrollment alone is refused). Anonymous rendezvous without registration is blocked.
- **HttpProxyRequest (#296):** schema support with `error: "not supported"` (no open HTTP egress proxy).
- **Guest WebSocket proxy:** `/ws/rendezvous` and `/ws/relay` validate guest tokens via Go `/guest/access-links/validate` before upgrade (non-empty `?guest=` alone is no longer sufficient).
- **RustDesk OIDC auth-query:** when the pending login recorded a device `id`/`uuid`, poll requests must supply matching non-empty values (omission no longer skips binding).
- Dependency / CI hardening: npm audit overrides (`tar` ≥7.5.21), govulncheck, Go toolchain bump, WebSocket auth for bd-signal / remote-agent.

### Changed
- Stable channel jump from **3.3.39** (previous `main`) through development patches **3.3.40–3.3.174**. Full per-patch history remains below; this section is the operator-facing **3.4.0** release summary (CI renames `[Unreleased]` on merge to `main`).

---

## [3.3.174] — 2026-07-24

### Security
- Guest WebSocket proxy validates access-link tokens before upgrade; RustDesk OIDC auth-query requires device id/uuid when pending recorded them; `tar` and `golang.org/x/text` bumps for audit/govulncheck.

### Changed
- _(none yet)_

---

## [3.3.173] — 2026-07-24

### Changed
- Release prep for upcoming stable **3.4.0** (curated notes live under `[Unreleased]` until `dev` → `main` merge).

---

## [3.3.172] — 2026-07-24

### Added
- **OIDC login for stock RustDesk desktop clients (#304):** when panel OIDC is enabled, `GET /api/login-options` advertises `oidc/<display name>`; clients use `POST /api/oidc/auth` + `GET /api/oidc/auth-query` (same IdP config / redirect family as panel SSO). Ships via panel update (Go API restart). Verify: enable OIDC → open RustDesk Login → SSO button appears → complete IdP login → client receives access token.

### Changed
- _(none yet)_

---

## [3.3.171] — 2026-07-24

### Changed
- _(none yet)_

---

## [3.3.170] — 2026-07-24

### Fixed
- **Fresh Docker install (#299):** `install.sh` default image tag synced to current `VERSION` (was stuck at 3.3.112 while compose/bump used a newer tag); summary falls back to `docker compose exec -u betterdesk … cat .admin_credentials` when `betterdesk-show-admin-credentials` is missing; split layout prints the correct compose service name (`console`). `betterdesk-docker.sh` password reset targets the all-in-one `betterdesk` container on single layout (no longer hardcodes `betterdesk-console`) and runs as UID `betterdesk` so `auth.db` is writable under `cap_drop: ALL`. Legacy split GHCR compose (`docker-compose.quick.yml`) uses `DB_PATH=/opt/rustdesk/db_v2.sqlite3` so the console no longer opens a read-only/orphan peer DB under `console-data` (`SQLITE_READONLY`). All-in-one image: `su-exec` packaged; entrypoint writes `.api_key` / enrollment sentinel as UID `betterdesk` (fresh named volumes inherit image ownership 10001 — root without `CAP_DAC_OVERRIDE` cannot create those files). `betterdesk-show-admin-credentials` falls back to `su` when `su-exec` is absent. `scripts/bump-version.js` now updates `install.sh` pins.
- **Unapproved Managed/Enrollment clients could start outbound sessions (#302):** signal `PunchHoleRequest` / `RequestRelay` now require a live registered initiator. In `managed` / `locked` modes the initiator must also have an approved peer row in the DB (pending enrollment alone is refused). Anonymous rendezvous without registration is blocked in all modes. Ships via panel update (Go signal restart). Stock RustDesk may still show Ready while pending; outbound connect fails until operator approval.

### Changed
- _(none yet)_

---

## [3.3.169] — 2026-07-23

### Changed
- _(none yet)_

---

## [3.3.168] — 2026-07-23

### Fixed
- **Postgres RustDesk `/api/login` Token generation failed (#300):** `CreateClientSession` no longer scans `RETURNING created_at` (TIMESTAMPTZ) into a Go `string`. INSERT now returns `to_char(... UTC)` like the existing session SELECT paths, so client login on PostgreSQL succeeds. Ships via panel update; restart Go, then sign in once in the RustDesk client.
- **Infinite user-create INSERT loop on PostgreSQL (#301):** panel `userSync.mirrorCreate` no longer POSTs to Go on shared Postgres (row already exists) and no longer recurses into create after a 409 when `GET /users` fails. Go Postgres `ListUsers`/`GetUser*` now `COALESCE(totp_secret, '')` so NULL secrets from panel inserts do not 500 the user list. Duplicate username at the DB layer returns a friendly `username_exists` error instead of a generic 500.

### Changed
- _(none yet)_

---

## [3.3.167] — 2026-07-22

### Changed
- _(none yet)_

---

## [3.3.166] — 2026-07-22

### Fixed
- **WSS relay decryption error after PeerInfo / H.265 (#293):** WebSocket relay no longer pipes paired peers through `websocket.NetConn` + `io.Copy`. That path split each large binary frame into ~32 KiB WebSocket messages, so encrypted video failed with `decryption error(0)` while small handshake messages (SignedId, PeerInfo) still worked. Relay now forwards complete WS messages end-to-end (same pattern as MeshCentral WS relay) and raises the WS read limit to 16 MiB.
- **User delete/demote silent failure on SQLite dual-DB (#292):** Go `ListUsers`/`GetUser*` no longer crash on NULL `last_login`/`totp_secret` (never-logged-in users). Migrate backfills NULLs; `CreateUser` sets `last_login=''`; last-admin guards honor `ListUsers` errors; `DeleteUser` clears `org_users` links. Panel `userSync` logs clearly when Go `/api/users` returns 500 so mirrors are not silently skipped.

### Changed
- _(none yet)_

---

## [3.3.165] — 2026-07-22

### Changed
- _(none yet)_

---

## [3.3.164] — 2026-07-22

### Fixed
- **Signal secure TCP `unhandled type <nil>` (#296):** after KeyExchange, modern clients may send `HttpProxyRequest` (protobuf field 27). The Go signal schema stopped at field 26 (`hc`), so decrypt succeeded but `Union` stayed nil and the connection was closed. Proto now includes `HttpProxyRequest`/`HttpProxyResponse`; the server replies with `error: "not supported"` (no open HTTP egress proxy). Empty encrypted frames are soft-ignored; unknown oneof fields log field numbers instead of opaque `<nil>`.
- **False MaxListenersExceededWarning on panel WebSocket upgrades (#295):** console WebSocket services now share a single HTTP `upgrade` dispatcher instead of stacking 11 separate listeners (Node's default max is 10). Reconnects never added listeners — the warning was a startup false positive, not a reconnect leak. Session `MemoryStore` remains intentional for the single-process console (shared store is for future multi-instance HA only).

### Changed
- _(none yet)_

---

## [3.3.163] — 2026-07-22

### Changed
- _(none yet)_

---

## [3.3.162] — 2026-07-22

### Fixed
- **OIDC SSO authorize redirect (#298):** clicking “Sign in with OIDC” no longer browser-redirects to the internal Go API URL (`http://localhost:21114/...`). The panel resolves the IdP authorize URL server-to-server and sends the browser only to the identity provider.

### Changed
- _(none yet)_

---

## [3.3.161] — 2026-07-22

### Security
- **Trusted proxy allowlist (#276):** Go signal/API honor `X-Real-IP` / `X-Forwarded-For` only when `TRUST_PROXY=Y` **and** the direct peer is listed in `TRUSTED_PROXIES` (CIDR/IP). Empty allowlist ignores forwarded headers (prevents spoofing if the Go port is reachable). WebSocket initiator delivery uses exact `ip:port` (`wsPunchConns`) so shared-NAT peers no longer receive another client's PunchHole/RelayResponse / signed PK.

### Changed
- _(none yet)_

---

## [3.3.160] — 2026-07-21

### Changed
- _(none yet)_

---

## [3.3.159] — 2026-07-21

### Fixed
- **Public Client Endpoints survive Docker recreate (#291):** Settings → Public client endpoints now persist on the `console-data` volume (`/app/data/public-endpoints.env`) instead of only ephemeral `/app/.env`. Optional Compose `PUBLIC_*` env vars override when non-empty; empty Compose keys no longer mask saved values.
- **Mixed WSS / native relay crash (#290):** relay sessions that pair a WebSocket peer (`:21119`) with a native TCP/TLS peer (`:21117`) are rejected instead of forwarding incompatible framings (`invalid message format` / `payload too large`). Signal returns `RefuseReason: Protocol mismatch…` when initiator and target connection types differ (WebSocket Mode vs native).

### Changed
- _(none yet)_

---

## [3.3.158] — 2026-07-21

### Changed
- _(none yet)_

---

## [3.3.157] — 2026-07-21

### Security
- **npm audit:** bump `protobufjs` to ≥7.6.5 and override `body-parser` to ≥1.20.6 (DoS advisories).
- **CI:** Secret Scan installs ripgrep before fingerprint script; CodeQL advanced workflow no longer runs on every push (conflicts with GitHub default setup SARIF upload).
- **Go signal:** keepalive timing overrides use atomics so `-race` tests no longer flake.
- **Go toolchain:** bump `betterdesk-server` toolchain to `go1.26.5` for govulncheck (GO-2026-5856 / stdlib TLS fixes).

### Fixed
- **Mesh relay:** `go vet` context cancel leak in `meshcentral/relay_ws.go` (defer cancel on all paths).

### Changed
- _(none yet)_

---

## [3.3.156] — 2026-07-20

### Security
- **Dependabot:** bumped `axios` to ≥1.18.0 and `brace-expansion` override to ≥1.1.16 in `web-nodejs` (DoS / prototype-pollution advisories).
- **CodeQL:** explicit `rdClientPageLimiter` on public mesh share/desktop routes; OIDC session redirect validates configured panel base instead of `HasPrefix`; ConnLimiter int→int32 clamp uses `math.MaxInt32`; clipboard test DOMParser mock uses stable multi-pass strip.

### Changed
- _(none yet)_

---

## [3.3.155] — 2026-07-20

### Changed
- _(none yet)_

---

## [3.3.154] — 2026-07-20

### Fixed
- **Guest Web Remote 500 + cookie hijack (#274):** `/remote/guest` no longer crashes during EJS render (guest bootstrap JSON uses the same safe pattern as the viewer). Panel sessions with `device.connect` win over a stale `betterdesk.guest` / `bd.guest` cookie, so operators are not hard-403’d on other device IDs after opening a guest link. Guest cookie is cleared on login and on `GET /remote` dashboard; RD WebSocket upgrades prefer `?guest=` on the session URL.
- **SQLite dual-DB local password for RustDesk client (#260):** startup `backfillFromNode` now copies the panel `password_hash` into missing Go `users` rows instead of creating a random placeholder password, so local panel passwords work for desktop client login without a manual reset.

### Changed
- **LDAP settings discoverability (#260):** Enrollment sub-tab hints that LDAP/AD and OIDC live under their own Authentication tabs; operator wiki and `ldap_enabled_hint` no longer imply LDAP fallthrough for local accounts.

---

## [3.3.153] — 2026-07-20

### Changed
- _(none yet)_

---

## [3.3.152] — 2026-07-20

### Fixed
- **WebSocket Mode relay timeout behind Nginx (#276 residual):** after the session-key fix, ephemeral WSS `RequestRelay` connections still failed because the signal server sent an immediate empty keepalive after HTTP 101. Desktop clients parse that as `RendezvousMessage{union:None}` and disconnect before `RelayResponse`. Keepalives now start after `RegisterPeer`/`RegisterPk`, or after a short idle delay only when the client has not sent any frame yet. Stale closed `WSConn` handles are cleared on forward failure.
- **RustDesk address book login “Token generation failed” (#284):** `POST /api/login` now logs the underlying `issueClientSession` error, validates user id before insert, and recreates the `client_sessions` table if a post-update DB was missing the #242 schema. Restart Go after panel update, then sign in once in the RustDesk client.

### Changed
- _(none yet)_

---

## [3.3.151] — 2026-07-18

### Fixed
- **Linux installer stale script after update (#219):** after Update replaces `betterdesk.sh` on disk, the interactive manager re-execs itself so Repair / Protocol Toggle use the new post-toggle tests (avoids false `HTTP redirect … on :5000` from the old in-memory script). Recreating systemd units preserves `PORT`/`HTTPS_PORT` from `.env` instead of resetting to `5000`/`5443`. Standard HTTPS (`:443`) post-tests always probe redirect on `:80`.

### Changed
- _(none yet)_

---

## [3.3.150] — 2026-07-18

### Changed
- _(none yet)_

---

## [3.3.149] — 2026-07-18

### Added
- **Guest Access Links for Web Remote / RdClient (#274):** operators can create a time-limited opaque link with a device allowlist. Guests open `/remote/guest?t=…`, see only those devices, and cannot use the plus/session-picker/quick-connect paths to reach other peers. No panel Console session is created. Mesh single-device share tunnel auth no longer requires a panel login when `mesh_share` is valid.

### Fixed
- **Linux HTTP/HTTPS post-toggle false fail (#219):** when the panel uses `HTTPS_PORT=443` / `PORT=80`, post-configuration tests no longer probe a stale `Environment=PORT=5000` from the systemd unit. Effective settings prefer `.env` (matches `EnvironmentFile=` precedence), standard-port repair syncs `PORT`/`HTTPS_PORT` into `betterdesk-console.service`, and redirect checks fall back to `:80` when that listener is active.

### Changed
- _(none yet)_

---

## [3.3.148] — 2026-07-18

### Changed
- _(none yet)_

---

## [3.3.147] — 2026-07-16

### Added
- **RustDesk client login → device owner (#270):** successful client login maps the device (`peers.user`) to the BetterDesk account for inventory/audit (shared logins, credential misuse). Does **not** block remote connections.

### Fixed
- **WebSocket mode behind Nginx (#276):** signal WSS no longer builds session keys as `IP:0` / `[IP:port]:0` from `X-Real-IP` / `X-Forwarded-For`. Forwarded addresses are parsed correctly when `TRUST_PROXY=Y`, and async PunchHole/RelayResponse delivery reaches WebSocket initiators (not only TCP punch connections).

### Changed
- _(none yet)_

---

## [3.3.146] — 2026-07-16

### Fixed
- **Windows panel update (#272):** default install under `C:\BetterDeskConsole` no longer treats drive root `C:\` as the project root. Installer/Docker files are written beside the console (avoids `EPERM: mkdir 'C:\'`), quick compose filenames are non-critical for SHA tracking, and NSSM `Access is denied` when restarting BetterDeskServer no longer leaves a stuck “updates available” state.

### Changed
- _(none yet)_

---

## [3.3.145] — 2026-07-14

### Changed
- _(none yet)_

---

## [3.3.144] — 2026-07-14

### Changed
- _(none yet)_

---

## [3.3.143] — 2026-07-14

### Fixed
- **External reverse proxy (#267):** wizard asks whether Caddy/Nginx runs on the same host; remote-proxy setups get `HOST=0.0.0.0` and LAN upstream in generated snippets (instead of always `127.0.0.1`).
- **OIDC SSO login (#269):** after IdP callback on the Go API port, the browser is redirected to the configured **Panel URL** (Settings → Authentication → OIDC) so the Node.js console can create the session cookie. Fixes `Invalid or missing credentials` on Docker / split-port setups. Also preserves post-login return URL from OAuth state and shows OIDC error messages on the login page.

### Changed
- _(none yet)_

---

## [3.3.142] — 2026-07-14

### Changed
- _(none yet)_

---

## [3.3.141] — 2026-07-14

### Added
- **External reverse proxy guidance (#267):** new [docs/setup/REVERSE_PROXY.md](docs/setup/REVERSE_PROXY.md); `betterdesk.sh` **External reverse proxy** mode (SSL menu **C** / Protocol Toggle **T**) applies `TRUST_PROXY=Y`, binds panel to localhost, enables Go `-trust-proxy`, and writes Caddy/Nginx snippets under `$RUSTDESK_PATH/reverse-proxy/`.

### Changed
- **Linux HTTP/HTTPS toggle (#219):** Node panel no longer pre-emptively downgrades `HTTPS_PORT=443` / `PORT=80` when `CAP_NET_BIND_SERVICE` is granted — detects ambient capability or `BETTERDESK_HAS_BIND_SERVICE=1` in the systemd unit. Repair HTTPS/TLS syncs `PORT=80` when `HTTPS_PORT=443`; installer health checks and post-toggle tests hint when the panel bound a fallback port (`:5443` / `:5000`).

---

## [3.3.140] — 2026-07-14

### Changed
- _(none yet)_

---

## [3.3.139] — 2026-07-14

### Docs
- **LDAP operator guide:** `docs/wiki/LDAP-AD.md` — AD setup, RustDesk client login, troubleshooting; cross-links from User Management wiki.

### Changed
- _(none yet)_

---

## [3.3.138] — 2026-07-13

### Changed
- _(none yet)_

---

## [3.3.137] — 2026-07-12

### Security
- **npm (dev):** bumped vitest/vite/esbuild in root and agent-client lockfiles; added `web-nodejs` overrides for `@babel/core` and `js-yaml` (Dependabot alerts #40–#48).
- **CodeQL:** `NewConnLimiterFromInt` for relay per-IP limits; removed dead `deepSet` from `patch-role-scope-i18n.js`; extended Dependabot npm coverage to repo root and agent-client; added `go/incorrect-conversion-between-integer-types` query filter.

### Changed
- _(none yet)_

---

## [3.3.136] — 2026-07-12

### Changed
- _(none yet)_

---

## [3.3.135] — 2026-07-12

### Security
- **Pre-3.4 hardening:** committed `web-nodejs/package-lock.json`; CI uses `npm ci` and blocks moderate+ npm audit findings; added `govulncheck` (Go), `cargo audit` (Tauri), Dependabot for npm/gomod.
- **Logging:** central Node logger (`LOG_LEVEL`, username redaction in stdout and `audit_log.details`); Go server `-log-level` / `LOG_LEVEL` filtering.
- **WebSocket auth:** `/ws/bd-signal` validates enrollment/access tokens; `/ws/remote-agent` requires single-use token from `POST /api/bd/remote-agent-token` or valid enrollment token; removed agent-client device_id token fallback.
- **Relay:** active paired sessions counted against per-IP limit (separate from pairing-phase limit); startup ERROR when `ENROLLMENT_MODE=open` without TLS on signal/relay.

### Changed
- Docker console build uses `npm ci --omit=dev` instead of `npm install --production`.

---

## [3.3.134] — 2026-07-12

### Changed
- _(none yet)_

---

## [3.3.133] — 2026-07-11

### Changed
- _(none yet)_

---

## [3.3.132] — 2026-07-10

### Changed
- _(none yet)_

---

## [3.3.131] — 2026-07-09

### Security
- **CodeQL:** advanced setup workflow (`.github/workflows/codeql.yml`) wires `.github/codeql/codeql-config.yml` so documented exclusions apply; `patch-role-scope-i18n.js` hardened against prototype pollution (`UNSAFE_NESTED_KEYS` guard).
- **XSS (org/CDAP pages):** page routes validate `orgId` / `deviceId` via `assertSafeApiId`; views escape IDs with server-side `escapeHtml`.

### Changed
- _(none yet)_

---

## [3.3.130] — 2026-07-09

### Changed
- _(none yet)_

---

## [3.3.129] — 2026-07-09

### Fixed
- **RustDesk client sessions (#242):** desktop/mobile clients no longer drop out after ~24 hours. Login now uses DB-backed session tokens (default **7 days**, sliding renewal on activity, max **30 days**). Configure under **Settings → Authentication → RustDesk clients**. Ships via panel update; sign in once in the client after updating.
- **Linux HTTP/HTTPS toggle (#219):** Go server now honours `GO_API_PORT=21114` over shared `.env` `API_PORT=21121` (Node Client API proxy), matching existing `SIGNAL_PORT` isolation. Installer and panel update patch `Environment=GO_API_PORT=21114` on `betterdesk-server.service`; post-toggle tests wait for Go API and hint when handlers leaked to `:21121`.

### Changed
- _(none yet)_

---

## [3.3.128] — 2026-07-09

### Changed
- _(none yet)_

### Docs
- **Server migration:** added manual / out-of-order migration troubleshooting (native install + `rust2go`, `TestNatRequest` without registration) in `docs/troubleshooting/SERVER_MIGRATION.md`.

---

## [3.3.127] — 2026-07-09

### Changed
- _(none yet)_

---

## [3.3.126] — 2026-07-07

### Changed
- _(none yet)_

---

## [3.3.125] — 2026-07-07

### Changed
- _(none yet)_

---

## [3.3.124] — 2026-07-07

### Changed
- _(none yet)_

---

## [3.3.123] — 2026-07-07

### Changed
- _(none yet)_

---

## [3.3.122] — 2026-07-07

### Fixed
- **Linux HTTP/HTTPS toggle (#219)** — `ensure_betterdesk_console_user` no longer prints repair warnings to stdout (they corrupted `User=` in `betterdesk-console.service` → `bad-setting`). Added `repair_console_service_user_line`, unified HTTPS repair on update/toggle, `SIGNAL_PORT=21116` / `RELAY_PORT=21117` in panel update service patch, ExecStartPre exits 0 on LE warnings-only, and port cleanup after graceful stop.

### Changed
- _(none yet)_

---

## [3.3.121] — 2026-07-06

### Changed
- _(none yet)_

---

## [3.3.120] — 2026-07-06

### Changed
- _(none yet)_

---

## [3.3.119] — 2026-07-06

### Changed
- _(none yet)_

---

## [3.3.118] — 2026-07-06

### Changed
- _(none yet)_

---

## [3.3.117] — 2026-07-06

### Changed
- _(none yet)_

---

## [3.3.116] — 2026-07-06

### Changed
- _(none yet)_

---

## [3.3.115] — 2026-07-06

### Changed
- _(none yet)_

---

## [3.3.114] — 2026-07-06

### Added
- **Web Remote — File Transfer drop zone:** left panel shows a drag-and-drop upload box (click to pick files, multi-file supported). Uploads go to the folder currently open on the remote side; progress appears in the Transfers column.
- **Web Remote — RustDesk file transfer parity:** 128 KB blocks, zstd upload compression, resume via `offset_blk` / `transferred_size`, overwrite confirmation dialog (Skip / Overwrite / apply to all), remote context menu (rename, delete, new folder), hidden-files toggle, and Resume in the transfer queue after errors.
- **Panel updater:** GitHub raw file downloads retry automatically on HTTP 429/502/503/504 (exponential backoff), reducing failed locale syncs during large updates.

### Changed
- _(none yet)_

---

## [3.3.113] — 2026-07-06

### Changed
- **Docker — official single container (default):** `install.sh` and quick-start docs now deploy one pre-built image (`ghcr.io/unitronix/betterdesk`) via `docker-compose.quick.single.yml`. Updates are a single `docker compose pull && up -d`. Legacy two-container layout remains available with `install.sh --split` or `docker-compose.quick.yml`. Panel update instructions respect `BETTERDESK_DOCKER_LAYOUT` (`single` vs `split`). Migrating from split to single reuses the same named volumes; RustDesk client API URL changes from port `21114` to `21121`.

---

## [3.3.112] — 2026-07-05

### Fixed
- **Panel ID change (regression on v3.3.101):** Web Console no longer forces custom device IDs to uppercase — case is preserved end-to-end (`MacPro1` stays `MacPro1`, not `MACPRO1`). After a panel-side rename, the Go signal server redirects heartbeats from the stale client ID to the successor row (preventing duplicate offline/online peer entries) and pushes a `PeerDiscovery` `change_id` notification to connected clients. Panel DB cascade uses the exact case sent to the Go API.

### Changed
- _(none yet)_

---

## [3.3.111] — 2026-07-05

### Changed
- _(none yet)_

---

## [3.3.110] — 2026-07-05

### Changed
- _(none yet)_

---

## [3.3.109] — 2026-07-05

### Fixed
- **Email/SMTP settings (Fixes #240):** Settings → Email “Test connection” no longer returns HTTP 415 — SMTP save/test/load now use `Utils.api()` so requests include `Content-Type: application/json` required by panel API middleware.
- **Panel tabs redirect to dashboard (401):** RustDesk client API routes (`GET /api/devices`, `/api/strategies`) no longer shadow panel session routes — browser requests without Bearer token fall through to panel handlers; `users.js` uses `/api/panel/strategies`; `Utils.api` no longer redirects logged-in users to `/login` (which bounced to dashboard) on incidental 401.
- **Devices/Users 429 rate limit:** extended panel poll whitelist (`/api/folders`, `/api/tags`, `/api/device-groups`, `/api/bd/notifications`, `/api/panel/*`); dedicated limiter for `POST /api/desktop/layout`; staggered Devices page API loads; desktop widget layout saves gated when desktop mode is inactive.

### Changed
- _(none yet)_

---

## [3.3.108] — 2026-07-05

### Changed
- _(none yet)_

---

## [3.3.107] — 2026-07-05

### Fixed
- **Server Admin navigation:** `server_admin` can open sidebar pages gated by `server.config` (Policies, Attestation, DataGuard, Generator, Users) — routes no longer require legacy `admin`/`global_admin` only; 403 template fixed for role checks; stale desktop-mode overlay cleared on load.
- **Dashboard 429 rate limit:** panel poll endpoints (`/api/dashboard/client-config`, activity, widgets, stats, etc.) now use the higher widget quota and no longer consume the 100/min general API budget — fixes `Too Many Requests` on dashboard load/refresh.

### Changed
- _(none yet)_

---

## [3.3.106] — 2026-07-05

### Changed
- _(none yet)_

---

## [3.3.105] — 2026-07-05

### Added
- **User scope UX (#227):** User Management now assigns **folders**, **direct devices**, and **RustDesk Pro strategies** per user; effective device count badge; folder ACL supports **allowed user groups**; optional **restricted default visibility** in Settings (`DEVICE_SCOPE_DEFAULT` / panel setting); docs [SCOPED_REMOTE_USER.md](docs/features/SCOPED_REMOTE_USER.md) and draft GitHub reply.

### Changed
- **Role labels (UI only):** `operator` → “Remote Operator”, `pro` → “Pro License (client API only)”; dynamic role descriptions and scope hints in user form (all 26 locales).

---

## [3.3.104] — 2026-07-05

### Changed
- _(none yet)_

---

## [3.3.103] — 2026-07-05

### Fixed
- **Device ID change (#213):** RustDesk 1.4.x client rename works again — the server accepts `RegisterPk` ID-change requests with an empty PK (stock client wire format) instead of returning `NOT_SUPPORT` / “Not yet supported by the server”.
- **Panel ID change:** Permanent delete now clears `id_change_history` so released IDs can be reused; panel/API ID changes cascade to enrollment tokens, org assignments, and linked peers; renamed-ID registration allows the same device (matching IP or PK/UUID) to stay connected after a panel-side rename.
- **Panel sync:** Go `peer_id_changed` events now cascade panel DB rows in real time; periodic Go→panel sync applies client-side renames; hard delete purges stale panel `peer` rows; BD-API `/register` uses the same identity-aware rename guard as the signal server.

### Changed
- **Panel UX:** Device list reloads on live ID-change events; online-device warning before change-ID from both list and detail views.
- **RustDesk Pro parity:** Panel strategies manager on Devices page; org address book structured editor; `/api/device-group/accessible` returns accessible payload (matches Go); Go API supports `POST /api/device-group`, strategy update/delete; device detail panel receives live status and ID-change events.
- **RustDesk Pro strategy assign:** Direct device/user/device-group strategy assignments via `POST /api/strategies/assign`, `GET /api/strategies/{guid}`, `PUT /api/strategies/{guid}/status`, and `GET /api/devices` (id + guid); panel UI “Assign targets” on the strategies manager; BetterDesk Go server mirrors the same endpoints.

---

## [3.3.102] — 2026-07-04

### Changed
- _(none yet)_

---

## [3.3.101] — 2026-07-04

### Changed
- _(none yet)_

---

## [3.3.100] — 2026-07-04

### Changed
- _(none yet)_

---

## [3.3.99] — 2026-07-04

### Changed
- _(none yet)_

---

## [3.3.98] — 2026-07-04

### Changed
- _(none yet)_

---

## [3.3.97] — 2026-07-04

### Changed
- _(none yet)_

---

## [3.3.96] — 2026-07-04

### Changed
- _(none yet)_

---

## [3.3.95] — 2026-07-04

### Changed
- _(none yet)_

---

## [3.3.94] — 2026-07-04

### Changed
- _(none yet)_

---

## [3.3.93] — 2026-07-03

### Changed
- _(none yet)_

---

## [3.3.92] — 2026-07-03

### Changed
- _(none yet)_

---

## [3.3.91] — 2026-07-03

### Changed
- _(none yet)_

---

## [3.3.90] — 2026-07-03

### Changed
- _(none yet)_

---

## [3.3.89] — 2026-07-03

### Fixed
- **Linux HTTP/HTTPS toggle (#219)** — `betterdesk-server.service` now sets `SIGNAL_PORT=21116` / `RELAY_PORT=21117` so panel `PORT=5000` in `.env` no longer makes the Go signal server bind `:5000` (conflict with the HTTPS redirect listener). Let's Encrypt redeploy removes same-path symlinks before `cp` (`cp: same file`). New **Repair → Repair HTTPS / TLS** menu path runs stuck-state repair (LE copy + signal ports); post-toggle tests wait for Go on `:21116` and surface the `:5000` mis-bind hint.
- **Deleted device ID management (#213):** Devices list now has a **Show deleted devices** toggle. Soft-deleted rows can be **Restored** or **permanently deleted** (releases the ID for reuse). Hard delete works for already-soft-deleted peers; change-ID conflicts map to a clear panel message instead of a generic server error.

### Changed
- _(none yet)_

---

## [3.3.88] — 2026-07-03

### Changed
- _(none yet)_

---

## [3.3.87] — 2026-07-01

### Fixed
- **RustDesk desktop WSS immediate EOF on `/ws/id`** — The Go signal WebSocket endpoint now sends an immediate empty keepalive frame after HTTP 101, honours `X-Forwarded-For` / `X-Real-IP` on upgrade, binds `WSConn` on `RegisterPeer`, and supports `WS_DEBUG_FRAMES=1` for first-frame diagnostics. Reported in ([#229](https://github.com/UNITRONIX/BetterDesk/issues/229)).

### Changed
- _(none yet)_

---

## [3.3.86] — 2026-06-30

### Changed
- _(none yet)_

---

## [3.3.85] — 2026-06-30

### Changed
- _(none yet)_

---

## [3.3.84] — 2026-06-30

### Changed
- _(none yet)_

---

## [3.3.83] — 2026-06-30

### Changed
- _(none yet)_

---

## [3.3.82] — 2026-06-30

### Changed
- _(none yet)_

---

## [3.3.81] — 2026-06-30

### Changed
- _(none yet)_

---

## [3.3.80] — 2026-06-29

### Fixed
- **Linux HTTP/HTTPS toggle hotfix (#219)**: `linux-ensure-console-user.js` contained a bash syntax fragment (`if [ -z ...`) that crashed the console on every start — fixed. LE repair also resolves the certbot live dir from the certificate SAN when `LE_CERT_LIVE_DIR` is missing.
- **Linux HTTP/HTTPS toggle follow-up (#219)**: panel updates and `betterdesk.sh` updates re-run Let's Encrypt TLS repair; SSL menu (C) unified with Protocol Toggle (T); post-toggle tests wait for Node boot.

### Changed
- **Let's Encrypt installer messaging (#219)**: after LE setup, the installer reminds operators to open `https://<domain>:5443` (IP access shows certificate name errors).

---

## [3.3.79] — 2026-06-28

### Changed
- _(none yet)_

---

## [3.3.78] — 2026-06-28

### Fixed
- **Linux Let's Encrypt HTTPS toggle (#219)**: `betterdesk.sh` now **copies** certbot material into `$RUSTDESK_PATH/ssl/` (real files with `root:betterdesk` permissions) instead of symlinking into `/etc/letsencrypt/` — the console service user could not read LE private keys and silently fell back to HTTP on `:5000`. Certbot deploy hook re-copies renewed certs; `ensure_betterdesk_console_user` repairs legacy symlink installs; post-toggle tests verify the console user can read the TLS key.

### Changed
- **Sensitive data anonymization**: removed operator-specific LAN IP, SSH user, and developer paths from public docs and examples; operator deploy runbooks moved to gitignored `docs/private/`; security contact updated; CI checks block regression (`scripts/check-no-sensitive-paths.sh`, `.gitleaks.toml`).

---

## [3.3.77] — 2026-06-27

### Fixed
- **Organization device groups (#221)**: editing a device group from the Devices page (e.g. switching to automatic tag membership) no longer clears `team_id`, so groups stay linked to their organization and org-scoped access is preserved.

### Changed
- _(none yet)_

---

## [3.3.76] — 2026-06-27

### Fixed
- **Public RustDesk client endpoints (#222)**: Dashboard client configuration, QR codes, deploy strings, and Keys page now honor `PUBLIC_SERVER_ID`, `PUBLIC_RELAY_SERVER`, and `PUBLIC_API_URL` when the console hostname differs from ID/relay/API (reverse proxy / split DNS). Settings → Public client endpoints edits `.env` without a console restart. `PANEL_PUBLIC_HOST` and Dashboard **Client server address** remain as fallbacks.

### Changed
- _(none yet)_

---

## [3.3.75] — 2026-06-27

### Fixed
- **NTP servers for billing clock (#223)**: `betterdesk-server` now loads `NTP_SERVERS` and billing clock vars from console `.env` (Linux `EnvironmentFile` + update migration). Added `BILLING_TRUST_OS_NTP` fallback when OS time sync is healthy but public NTP is blocked. Commercialization → Settings exposes NTP configuration with Go server restart.

### Changed
- _(none yet)_

---

## [3.3.74] — 2026-06-27

### Changed
- _(none yet)_

---

## [3.3.73] — 2026-06-26

### Changed
- _(none yet)_

---

## [3.3.72] — 2026-06-26

### Changed
- _(none yet)_

---

## [3.3.71] — 2026-06-26

### Changed
- _(none yet)_

---

## [3.3.70] — 2026-06-26

### Changed
- _(none yet)_

---

## [3.3.69] — 2026-06-26

### Fixed
- **Web Remote file transfer (#217)**: upload now sends the full destination file path (not just the directory); downloads default to the browser Downloads folder; transfer queue shows phases, progress, cancel, and stall timeout; drag-and-drop overlay on the remote panel; optional local folder save via File System Access when chosen.
- **Web Remote file transfer protocol (#217)**: fix inverted RustDesk FileAction mapping — download uses `send` (full remote path), upload uses `receive` (remote dir + FileEntry); upload sends `send_confirm` before blocks; optional zstd block decompress on download.
- **Panel update sudoers bootstrap (Linux)**: `linux-ensure-console-user.js` is whitelisted in sudoers and invoked via passwordless sudo during updates; server binary deploy refreshes sudoers as root so new privileged helpers (e.g. `linux-write-systemd-unit.js`) apply without a manual root step.

### Changed
- _(none yet)_

---

## [3.3.68] — 2026-06-26

### Changed
- _(none yet)_

---

## [3.3.67] — 2026-06-26

### Fixed
- **OIDC SSO login (#225)**: panel callback now calls the missing `exchangeOIDCCode` Go API client method so one-time auth codes are exchanged server-to-server after IdP redirect (fixes `TypeError: betterdeskApi.exchangeOIDCCode is not a function`).
- **RdClient desktop (#226)**: Windows build — pass `&str` to WebView2 `additional_browser_args` (fixes compile error after GPU/media args refactor).

### Changed
- _(none yet)_

---

## [3.3.66] — 2026-06-24

### Changed
- _(none yet)_

---

## [3.3.65] — 2026-06-24

### Fixed
- **Web Remote file transfer (#217)**: opens a dedicated `FILE_TRANSFER` relay session (separate from the desktop tunnel) so RustDesk peers handle `FileAction` messages. Replaces the side panel with a RustDesk-style centered modal (local | remote | transfer queue); local folder browsing uses the File System Access API on Chrome/Edge with HTTPS fallback. CDAP snapshot sessions disable the file-transfer toolbar button.
- **Panel update systemd unit patch (Linux)**: service config cleanup no longer calls interactive `sudo tee`; uses a whitelisted passwordless-sudo helper for `betterdesk-server.service` / `betterdesk-console.service` after `linux-ensure-console-user.js` refreshes sudoers.

### Changed
- **Web Remote toolbar UX**: hides “Connected” status text and frame count while streaming; removes the in-viewer language picker. Fullscreen (toolbar button, handle, F11) now covers the tab bar, viewer, and floating toolbar via `#rd-viewer-shell`.

---

## [3.3.64] — 2026-06-24

### Fixed
- **RustDesk client LDAP login (#218)**: `POST /api/login` on the Go API now uses the same provider-bound LDAP/AD authentication as the web console (`/api/auth/login`). LDAP-bound and auto-provisioned directory users can sign in to the RustDesk desktop client with domain username/password; TOTP still applies when enabled locally.

### Changed
- _(none yet)_

---

## [3.3.63] — 2026-06-24

### Fixed
- **Linux HTTP/HTTPS protocol toggle (#219)**: `betterdesk.sh` now syncs `.env` and `betterdesk-console.service` consistently (`RUSTDESK_API_TLS`, SSL paths, redirect flags); health checks use `HTTPS_PORT` (5443) instead of conflating with `PORT` (5000); post-toggle tests probe Client API with the correct scheme. Panel HTTP→HTTPS redirect uses 307 + `no-store`; HSTS is skipped when `ALLOW_SELF_SIGNED_CERTS=true` so toggling back to HTTP does not leave year-long browser enforcement.

### Changed
- _(none yet)_

---

## [3.3.62] — 2026-06-22

### Fixed
- **RdClient Web phone gate**: fixed mobile device detection that blocked access on PC, tablets, and unfolded foldables with “Remote desktop requires a larger screen”. Gate now respects `[hidden]`, skips zero-width false positives, excludes fine-pointer desktops, and re-evaluates on viewport resize. Ships via Settings → Updates.

### Changed
- _(none yet)_

---

## [3.3.61] — 2026-06-21

### Changed
- _(none yet)_

---

## [3.3.60] — 2026-06-21

### Changed
- **Mesh layer closure**: `MESH_ENABLED=Y` default in Go config; installers (`betterdesk.sh` / `betterdesk.ps1`) and panel updater inject `MESH_ENABLED=Y` on existing Linux/Windows services; mesh cert backup on update.
- **Panel**: Settings mesh groups + session recordings list + onboarding; Devices `mesh_agent` filter, linked-peer badge, power/port menu; remote server-side recording toggle; i18n for all locales.
- **Go mesh**: KVM relay multiplex (multi-viewer), WoL wake fallback via `linked_peer_id`, recordings list/download APIs, device group assign, `mesh.terminal` / `mesh.files` / `mesh.power` RBAC.
- **Docs/tests**: [MESH_REST_AUTOMATION.md](docs/features/MESH_REST_AUTOMATION.md), updated compat gap table; `mesh.routes` Jest test; stabilized MeshAgent live test timeout.

---

## [3.3.59] — 2026-06-21

### Added
- **MeshCentral compatibility layer** (optional `MESH_ENABLED=Y`): native Go implementation of `/agent.ashx`, `/meshrelay.ashx`, and `/control.ashx` for unmodified MeshAgent binaries; unified inventory with `mesh_agent` device type; rdclient web `transport=mesh`; REST helpers (`/api/mesh/*`, `POST /api/peers/{id}/exec`); panel `.msh` download and `.ashx` WebSocket proxy. See [docs/features/MESHAGENT_ONBOARDING.md](docs/features/MESHAGENT_ONBOARDING.md).

### Changed
- **Mesh agent assets**: AGPL **BetterCore** (`bettercore.js`) and **BetterViewer** (`betterviewer.js`) replace vendored upstream MeshCentral JavaScript.
- **BetterCore phase 2**: consent prompts, WebRTC tunnel handoff, PowerShell terminals (`p=6`/`p=9`); interop CI with simulated handshake + live MeshAgent binary job.
- **Mesh operator tools**: guest desktop share links (`mesh_share`), TCP/UDP port relay (`POST /api/mesh/devices/{id}/tcp` / `udp`), device power actions (sleep/reset), session recording to `.mcrec`, Settings → MeshCentral section, linked-peer UX in device menu.

---

## [3.3.58] — 2026-06-21

### Changed
- _(none yet)_

---

## [3.3.57] — 2026-06-21

### Changed
- _(none yet)_

---

## [3.3.56] — 2026-06-20

### Changed
- _(none yet)_

---

## [3.3.55] — 2026-06-20

### Changed
- _(none yet)_

---

## [3.3.54] — 2026-06-20

### Changed
- _(none yet)_

---

## [3.3.53] — 2026-06-20

### Changed
- _(none yet)_

---

## [3.3.52] — 2026-06-20

### Changed
- _(none yet)_

---

## [3.3.51] — 2026-06-20

### Changed
- _(none yet)_

---

## [3.3.50] — 2026-06-20

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
[3.3.50]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.49...v3.3.50
[3.3.51]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.50...v3.3.51
[3.3.52]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.51...v3.3.52
[3.3.53]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.52...v3.3.53
[3.3.54]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.53...v3.3.54
[3.3.55]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.54...v3.3.55
[3.3.56]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.55...v3.3.56
[3.3.57]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.56...v3.3.57
[3.3.58]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.57...v3.3.58
[3.3.59]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.58...v3.3.59
[3.3.60]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.59...v3.3.60
[3.3.61]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.60...v3.3.61
[3.3.62]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.61...v3.3.62
[3.3.63]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.62...v3.3.63
[3.3.64]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.63...v3.3.64
[3.3.65]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.64...v3.3.65
[3.3.66]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.65...v3.3.66
[3.3.67]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.66...v3.3.67
[3.3.68]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.67...v3.3.68
[3.3.69]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.68...v3.3.69
[3.3.70]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.69...v3.3.70
[3.3.71]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.70...v3.3.71
[3.3.72]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.71...v3.3.72
[3.3.73]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.72...v3.3.73
[3.3.74]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.73...v3.3.74
[3.3.75]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.74...v3.3.75
[3.3.76]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.75...v3.3.76
[3.3.77]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.76...v3.3.77
[3.3.78]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.77...v3.3.78
[3.3.79]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.78...v3.3.79
[3.3.80]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.79...v3.3.80
[3.3.81]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.80...v3.3.81
[3.3.82]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.81...v3.3.82
[3.3.83]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.82...v3.3.83
[3.3.84]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.83...v3.3.84
[3.3.85]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.84...v3.3.85
[3.3.86]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.85...v3.3.86
[3.3.87]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.86...v3.3.87
[3.3.88]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.87...v3.3.88
[3.3.89]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.88...v3.3.89
[3.3.90]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.89...v3.3.90
[3.3.91]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.90...v3.3.91
[3.3.92]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.91...v3.3.92
[3.3.93]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.92...v3.3.93
[3.3.94]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.93...v3.3.94
[3.3.95]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.94...v3.3.95
[3.3.96]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.95...v3.3.96
[3.3.97]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.96...v3.3.97
[3.3.98]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.97...v3.3.98
[3.3.99]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.98...v3.3.99
[3.3.100]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.99...v3.3.100
[3.3.101]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.100...v3.3.101
[3.3.102]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.101...v3.3.102
[3.3.103]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.102...v3.3.103
[3.3.104]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.103...v3.3.104
[3.3.105]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.104...v3.3.105
[3.3.106]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.105...v3.3.106
[3.3.107]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.106...v3.3.107
[3.3.108]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.107...v3.3.108
[3.3.109]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.108...v3.3.109
[3.3.110]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.109...v3.3.110
[3.3.111]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.110...v3.3.111
[3.3.112]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.111...v3.3.112
[3.3.113]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.112...v3.3.113
[3.3.114]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.113...v3.3.114
[3.3.115]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.114...v3.3.115
[3.3.116]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.115...v3.3.116
[3.3.117]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.116...v3.3.117
[3.3.118]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.117...v3.3.118
[3.3.119]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.118...v3.3.119
[3.3.120]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.119...v3.3.120
[3.3.121]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.120...v3.3.121
[3.3.122]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.121...v3.3.122
[3.3.123]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.122...v3.3.123
[3.3.124]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.123...v3.3.124
[3.3.125]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.124...v3.3.125
[3.3.126]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.125...v3.3.126
[3.3.127]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.126...v3.3.127
[3.3.128]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.127...v3.3.128
[3.3.129]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.128...v3.3.129
[3.3.130]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.129...v3.3.130
[3.3.131]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.130...v3.3.131
[3.3.132]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.131...v3.3.132
[3.3.133]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.132...v3.3.133
[3.3.134]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.133...v3.3.134
[3.3.135]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.134...v3.3.135
[3.3.136]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.135...v3.3.136
[3.3.137]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.136...v3.3.137
[3.3.138]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.137...v3.3.138
[3.3.139]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.138...v3.3.139
[3.3.140]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.139...v3.3.140
[3.3.141]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.140...v3.3.141
[3.3.142]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.141...v3.3.142
[3.3.143]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.142...v3.3.143
[3.3.144]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.143...v3.3.144
[3.3.145]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.144...v3.3.145
[3.3.146]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.145...v3.3.146
[3.3.147]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.146...v3.3.147
[3.3.148]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.147...v3.3.148
[3.3.149]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.148...v3.3.149
[3.3.150]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.149...v3.3.150
[3.3.151]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.150...v3.3.151
[3.3.152]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.151...v3.3.152
[3.3.153]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.152...v3.3.153
[3.3.154]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.153...v3.3.154
[3.3.155]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.154...v3.3.155
[3.3.156]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.155...v3.3.156
[3.3.157]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.156...v3.3.157
[3.3.158]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.157...v3.3.158
[3.3.159]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.158...v3.3.159
[3.3.160]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.159...v3.3.160
[3.3.161]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.160...v3.3.161
[3.3.162]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.161...v3.3.162
[3.3.163]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.162...v3.3.163
[3.3.164]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.163...v3.3.164
[3.3.165]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.164...v3.3.165
[3.3.166]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.165...v3.3.166
[3.3.167]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.166...v3.3.167
[3.3.168]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.167...v3.3.168
[3.3.169]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.168...v3.3.169
[3.3.170]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.169...v3.3.170
[3.3.171]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.170...v3.3.171
[3.3.172]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.171...v3.3.172
[3.3.173]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.172...v3.3.173
[3.3.174]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.173...v3.3.174
[3.4.0]: https://github.com/UNITRONIX/BetterDesk/compare/v3.3.174...v3.4.0
[3.4.1]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.0...v3.4.1
[3.4.2]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.1...v3.4.2
[3.4.3]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.2...v3.4.3
[3.4.4]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.3...v3.4.4
[3.4.5]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.4...v3.4.5
[3.4.6]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.5...v3.4.6
[3.4.7]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.6...v3.4.7
[3.4.8]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.7...v3.4.8
[3.4.9]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.8...v3.4.9
[3.4.10]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.9...v3.4.10
[3.4.11]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.10...v3.4.11
[3.4.12]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.11...v3.4.12
[3.4.13]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.12...v3.4.13
[3.4.14]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.13...v3.4.14
[3.4.15]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.14...v3.4.15
[3.5.0]: https://github.com/UNITRONIX/BetterDesk/compare/v3.4.15...v3.5.0
[3.5.1]: https://github.com/UNITRONIX/BetterDesk/compare/v3.5.0...v3.5.1
[3.5.2]: https://github.com/UNITRONIX/BetterDesk/compare/v3.5.1...v3.5.2
