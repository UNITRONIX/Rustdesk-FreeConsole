# BetterDesk Console - Instrukcje dla Copilota

> Ten plik jest automatycznie dołączany do kontekstu rozmów z GitHub Copilot.
> Zawiera aktualne informacje o stanie projektu i wytyczne do dalszej pracy.

---

## 📝 Konwencja Commitów (OBOWIĄZKOWE)

**Każdy commit MUSI zawierać wzmiankę o Insolve w stopce wiadomości.**

Format:
```
<type>(<scope>): <short description>

<optional body with details>

This commit was made possible thanks to Insolve.
```

Przykład wywołania w PowerShell:
```powershell
git commit -m "fix(sidebar): translate user role" -m "Details about the change." -m "This commit was made possible thanks to Insolve."
```

Zasady:
- Stopka `This commit was made possible thanks to Insolve.` jest wymagana w **każdym** commicie, niezależnie od rozmiaru zmiany.
- Stopka musi być ostatnim `-m` (lub ostatnim akapitem wiadomości).
- Nie pomijaj jej nawet dla trywialnych zmian (literówki, formatowanie, drobne fixy).
- Jeśli używasz `git commit -m "..."` jednoliniowo — i tak dołącz stopkę przez dodatkowe `-m`.

---

## 📊 Stan Projektu (aktualizacja: 2026-04-10)

### Wersja Skryptów ALL-IN-ONE (v2.4.0)

| Plik | Wersja | Platforma | Status |
|------|--------|-----------|--------|
| `betterdesk.sh` | v2.4.0 | Linux | ✅ ALL-IN-ONE + Node.js only + SSL config + PostgreSQL + Auto mode |
| `betterdesk.ps1` | v2.4.0 | Windows | ✅ ALL-IN-ONE + Node.js only + SSL config + PostgreSQL + Auto mode |
| `betterdesk-docker.sh` | v2.4.0 | Docker | ✅ Interaktywny ALL-IN-ONE + PostgreSQL + Migration |

### Konsole Webowe

| Typ | Folder | Status | Opis |
|-----|--------|--------|------|
| **Node.js** | `web-nodejs/` | ✅ Aktywna (jedyna) | Express.js, EJS, better-sqlite3, CSRF, TOTP 2FA |
| **Flask** | `archive/web-flask/` | 📦 Archived | Python, Jinja2 - przeniesiony do archiwum |

### Serwer BetterDesk (Go)

| Komponent | Folder | Status | Opis |
|-----------|--------|--------|------|
| **Go Server** | `betterdesk-server/` | ✅ Production-ready | Single binary replacing hbbs+hbbr, ~20K LOC Go |
| **Rust (archived)** | `archive/hbbs-patch-v2/` | 📦 Archived | Patched Rust binaries v2.1.3 - przeniesione do archiwum |

### BetterDesk MGMT Client (Tauri + SolidJS) — Operator/Admin Console

| Komponent | Folder | Status | Opis |
|-----------|--------|--------|------|
| **MGMT Client** | `betterdesk-mgmt/` | ⚠️ Alpha (v1.0.0) | Tauri v2, SolidJS, operator/admin desktop app |
| **Installer NSIS** | `src-tauri/target/release/bundle/nsis/` | ✅ | `BetterDesk_MGMT_1.0.0_x64-setup.exe` |
| **Installer MSI** | `src-tauri/target/release/bundle/msi/` | ✅ | `BetterDesk_MGMT_1.0.0_x64_en-US.msi` |

### BetterDesk Agent Client (Tauri + SolidJS) — Endpoint Device Agent

| Komponent | Folder | Status | Opis |
|-----------|--------|--------|------|
| **Agent Client** | `betterdesk-agent-client/` | ⚠️ Alpha (v1.0.0) | Tauri v2, SolidJS, lightweight endpoint agent |
| **Installer NSIS** | `src-tauri/target/release/bundle/nsis/` | ✅ | `BetterDesk_Agent_1.0.0_x64-setup.exe` |

### Serwer Go — Binaries (NIE są w repozytorium, kompilowane lokalnie)

| Platforma | Plik | Status |
|-----------|------|--------|
| Linux x86_64 | `betterdesk-server-linux-amd64` | Kompiluj lokalnie: `go build` |
| Linux ARM64 | `betterdesk-server-linux-arm64` | Kompiluj lokalnie: `GOARCH=arm64 go build` |
| Windows x86_64 | `betterdesk-server.exe` | Kompiluj lokalnie: `GOOS=windows go build` |

---

## 🚀 Skrypty ALL-IN-ONE (v2.4.0)

### Nowe funkcje w v2.4.0

- ✅ **PostgreSQL support** - full PostgreSQL database support for Go server and Node.js console
- ✅ **SQLite → PostgreSQL migration** - built-in migration tool (menu option M/P)
- ✅ **Database type selection** - choose SQLite or PostgreSQL during installation
- ✅ **Docker PostgreSQL** - PostgreSQL container with health checks in docker-compose
- ✅ **Connection pooling** - pgxpool with configurable limits via DSN params
- ✅ **LISTEN/NOTIFY** - real-time event push between Go server instances

### Previous versions

#### v2.3.0
- ✅ **Flask removed** - Flask console deprecated, Node.js is now the only option
- ✅ **SSL certificate configuration** - new menu option C for SSL/TLS setup (Let's Encrypt, custom cert, self-signed)
- ✅ **Security audit fixes** - CSRF protection, session fixation prevention, timing-safe auth, WebSocket auth
- ✅ **TOTP 2FA** - Two-factor authentication with TOTP (otplib)
- ✅ **RustDesk Client API** - dedicated WAN-facing port (21121) with 7-layer security
- ✅ **Address book sync** - full AB storage with address_books table
- ✅ **Operator role** - separate admin/operator roles with different permissions
- ✅ **Desktop connect button** - connect to devices from browser (RustDesk URI handler)

#### v2.2.1
- ✅ Node.js .env config fixes, admin password fixes, systemd fixes

#### v2.2.0
- ✅ Node.js/Flask choice (Flask now deprecated)
- ✅ Migration between consoles
- ✅ Automatic Node.js installation

### Nowe funkcje w v2.1.2

- ✅ **Poprawka systemu banowania** - ban dotyczy tylko konkretnego urządzenia, nie wszystkich z tego samego IP
- ✅ **Poprawka migracji w trybie auto** - migracje bazy danych działają bez interakcji
- ✅ **Weryfikacja SHA256** - automatyczna weryfikacja sum kontrolnych binarek
- ✅ **Tryb automatyczny** - instalacja bez interakcji użytkownika (`--auto` / `-Auto`)
- ✅ **Konfigurowalne porty API** - zmienne środowiskowe `API_PORT`
- ✅ **Ulepszone usługi systemd** - lepsze konfiguracje z dokumentacją

### Funkcje wspólne dla wszystkich skryptów

1. 🚀 **New installation** - full installation from scratch (Node.js only)
2. ⬆️ **Update** - update existing installation
3. 🔧 **Repair** - automatic fix for common issues
4. ✅ **Validation** - check installation correctness
5. 💾 **Backup** - create backups
6. 🔐 **Password reset** - reset admin password
7. 🔨 **Build binaries** - compile from source
8. 📊 **Diagnostics** - detailed problem analysis
9. 🗑️ **Uninstall** - full removal
10. 🔒 **SSL config** - configure SSL/TLS certificates (NEW in v2.3.0)
11. 🔄 **Migrate** - migrate from existing RustDesk Docker (Docker script only)
12. 🔀 **Database migration** - migrate databases between Rust/Node.js/Go/PostgreSQL (NEW)

### Użycie

```bash
# Linux - tryb interaktywny
sudo ./betterdesk.sh

# Linux - tryb automatyczny
sudo ./betterdesk.sh --auto

# Linux - pomiń weryfikację SHA256
sudo ./betterdesk.sh --skip-verify

# Windows (PowerShell jako Administrator) - tryb interaktywny
.\betterdesk.ps1

# Windows - tryb automatyczny
.\betterdesk.ps1 -Auto

# Windows - pomiń weryfikację SHA256
.\betterdesk.ps1 -SkipVerify

# Docker
./betterdesk-docker.sh
```

---

## 🛠️ Konfiguracja portu API

### Zmienne środowiskowe

```bash
# Linux - niestandardowy port API
API_PORT=21120 sudo ./betterdesk.sh --auto

# Windows
$env:API_PORT = "21114"
.\betterdesk.ps1 -Auto
```

### Domyślne porty

| Port | Usługa | Opis |
|------|--------|------|
| 21120 | HTTP API (Linux) | BetterDesk HTTP API (domyślny Linux) |
| 21114 | HTTP API (Windows) | BetterDesk HTTP API (domyślny Windows) |
| 21115 | TCP | NAT type test |
| 21116 | TCP/UDP | ID Server (rejestracja klientów) |
| 21117 | TCP | Relay Server |
| 5000 | HTTP | Web Console (admin panel) |
| 21121 | TCP | RustDesk Client API (WAN-facing, dedicated) |

### Skrypt diagnostyczny (dev)
```bash
# Szczegółowa diagnostyka offline status
./dev_modules/diagnose_offline_status.sh
```

---

## 🏗️ Architektura

### Struktura Katalogów

```
Rustdesk-FreeConsole/
├── betterdesk-server/       # Go server (replacing hbbs+hbbr) — ~20K LOC
│   ├── main.go              # Entry point, flags, boot
│   ├── signal/              # Signal server (UDP/TCP/WS)
│   ├── relay/               # Relay server (TCP/WS)
│   ├── api/                 # HTTP REST API + auth handlers
│   ├── crypto/              # Ed25519 keys, NaCl secure TCP, addr codec
│   ├── db/                  # Database interface + SQLite impl (future: PostgreSQL)
│   ├── config/              # Configuration + constants
│   ├── codec/               # Wire protocol framing
│   ├── peer/                # Concurrent in-memory peer map
│   ├── security/            # IP/ID/CIDR blocklist
│   ├── auth/                # JWT, PBKDF2, roles, TOTP
│   ├── ratelimit/           # Bandwidth + conn + IP rate limit
│   ├── metrics/             # Prometheus exposition
│   ├── audit/               # Ring-buffer audit log
│   ├── events/              # Pub/sub event bus
│   ├── logging/             # Text/JSON structured logging
│   ├── admin/               # TCP management console
│   ├── reload/              # Hot-reload (SIGHUP)
│   ├── proto/               # Generated protobuf (rendezvous + message)
│   └── tools/               # Migration utilities
├── web-nodejs/              # Node.js web console (active)
├── betterdesk-mgmt/         # MGMT Client — operator/admin desktop app (Tauri v2 + SolidJS)
│   ├── src/                 # SolidJS frontend (components, i18n, styles)
│   └── src-tauri/           # Rust backend (~40K LOC, 25+ modules, 100+ IPC commands)
├── betterdesk-agent-client/ # Agent Client — lightweight endpoint agent (Tauri v2 + SolidJS)
│   ├── src/                 # SolidJS frontend (4 views, minimal UI)
│   └── src-tauri/           # Rust backend (config, registration, sysinfo, 17 IPC commands)
├── betterdesk-agent/        # Native CDAP agent (Go binary)
│   ├── main.go              # CLI entry point, 14 flags, signal handling
│   ├── agent/               # Core: config, agent, system, manifest, terminal, filebrowser, clipboard, screenshot
│   └── install/             # Systemd + NSSM service installers
├── sdks/                    # CDAP Bridge SDKs
│   ├── python/              # betterdesk-cdap v1.0.0 (async CDAPBridge, Widget helpers)
│   └── nodejs/              # betterdesk-cdap v1.0.0 (EventEmitter CDAPBridge, Widget class)
├── bridges/                 # Reference CDAP bridges
│   ├── modbus/              # Modbus TCP/RTU bridge (pymodbus)
│   ├── snmp/                # SNMP v2c/v3 bridge (pysnmplib)
│   └── rest-webhook/        # REST polling + webhook bridge (aiohttp)
├── web/                     # Flask web console (deprecated)
├── hbbs-patch-v2/           # Legacy Rust server binaries (v2.1.3)
│   ├── hbbs-linux-x86_64    # Signal server Linux (Rust)
│   ├── hbbr-linux-x86_64    # Relay server Linux (Rust)
│   ├── hbbs-windows-x86_64.exe  # Signal server Windows (Rust)
│   ├── hbbr-windows-x86_64.exe  # Relay server Windows (Rust)
│   └── src/                 # Rust source code modifications
├── docs/                    # Documentation (English)
├── dev_modules/             # Development & testing utilities
├── archive/                 # Archived files (not in git)
├── Dockerfile.*             # Docker images
├── docker-compose.yml       # Docker orchestration
└── migrations/              # Database migrations
```

### Porty

| Port | Usługa | Opis |
|------|--------|------|
| 21114 | HTTP API | BetterDesk Server REST API (Go/Rust) |
| 21115 | TCP | NAT type test + OnlineRequest |
| 21116 | TCP/UDP | Signal Server (client registration, punch hole) |
| 21117 | TCP | Relay Server (bidirectional stream) |
| 21118 | WS | WebSocket Signal (signal port + 2) |
| 21119 | WS | WebSocket Relay (relay port + 2) |
| 5000 | HTTP | Web Console (admin panel, LAN) |
| 21121 | TCP | RustDesk Client API (WAN-facing, Node.js) |
| 21122 | WS | CDAP Gateway (WebSocket, path: /cdap) |

### Go Server — Architecture Flow

```
RustDesk Client
  ├── UDP (:21116) → signal/serveUDP → RegisterPeer, PunchHole, RequestRelay
  ├── TCP (:21116) → signal/serveTCP → NaCl KeyExchange → secure channel
  ├── WS  (:21118) → signal/serveWS → websocket signal
  ├── TCP (:21117) → relay/serveTCP → UUID pairing → io.Copy bidirectional
  ├── WS  (:21119) → relay/serveWS → websocket relay
  └── TCP (:21115) → signal/serveNAT → TestNatRequest, OnlineRequest

Console/Admin
  ├── HTTP (:21114) → api/server → JWT/API-key → REST handlers
  ├── TCP  (admin)  → admin/server → CLI management
  └── WS   (:21114) → events/bus → real-time push
```

---

## 🔧 Procedury Kompilacji

### Windows (wymagania)
- Rust 1.70+ (`rustup update`)
- Visual Studio Build Tools z C++ support
- Git

### Kompilacja Windows
```powershell
# 1. Pobierz źródła RustDesk
git clone --branch 1.1.14 https://github.com/rustdesk/rustdesk-server.git
cd rustdesk-server
git submodule update --init --recursive

# 2. Skopiuj modyfikacje BetterDesk
copy ..\hbbs-patch-v2\src\main.rs src\main.rs
copy ..\hbbs-patch-v2\src\http_api.rs src\http_api.rs

# 3. Kompiluj
cargo build --release

# 4. Binarki w: target\release\hbbs.exe, target\release\hbbr.exe
```

### Linux (wymagania)
```bash
sudo apt-get install -y build-essential libsqlite3-dev pkg-config libssl-dev git
```

---

## 🧪 Środowiska Testowe

### Serwer SSH (Linux tests)
- **Host:** `user@your-server-ip` (skonfiguruj własny serwer testowy)
- **Użycie:** Testowanie binarek Linux, sprawdzanie logów

### Windows (local)
- Testowanie binarek Windows bezpośrednio na maszynie deweloperskiej

---

## 📋 Aktualne Zadania

### ✅ Ukończone (2026-02-04)
1. [x] Usunięto stary folder `hbbs-patch` (v1)
2. [x] Skompilowano binarki Windows v2.0.0
3. [x] Przetestowano binarki na obu platformach
4. [x] Zaktualizowano CHECKSUMS.md
5. [x] Dodano --fix i --diagnose do install-improved.sh (v1.5.5)
6. [x] Dodano -Fix i -Diagnose do install-improved.ps1 (v1.5.1)
7. [x] Dodano obsługę hbbs-patch-v2 binarek Windows w instalatorze PS1
8. [x] Utworzono diagnose_offline_status.sh
9. [x] Zaktualizowano TROUBLESHOOTING_EN.md (Problem 3: Offline Status)

### ✅ Ukończone (2026-02-06)
10. [x] **Naprawiono Docker** - Dockerfile.hbbs/hbbr teraz kopiują binarki BetterDesk z hbbs-patch-v2/
11. [x] **Naprawiono "no such table: peer"** - obrazy Docker używają teraz zmodyfikowanych binarek
12. [x] **Naprawiono "pull access denied"** - dodano `pull_policy: never` w docker-compose.yml
13. [x] **Naprawiono DNS issues** - dodano fallback DNS w Dockerfile.console (AlmaLinux/CentOS)
14. [x] Zaktualizowano DOCKER_TROUBLESHOOTING.md z nowymi rozwiązaniami

### ✅ Ukończone (2026-02-07)
15. [x] **Stworzono build-betterdesk.sh** - interaktywny skrypt do kompilacji (Linux/macOS)
16. [x] **Stworzono build-betterdesk.ps1** - interaktywny skrypt do kompilacji (Windows)
17. [x] **Stworzono GitHub Actions workflow** - automatyczna kompilacja multi-platform (.github/workflows/build.yml)
18. [x] **Stworzono BUILD_GUIDE.md** - dokumentacja budowania ze źródeł
19. [x] **System statusu v3.0** - konfigurowalny timeout, nowe statusy (Online/Degraded/Critical/Offline)
20. [x] **Nowe endpointy API** - /api/config, /api/peers/stats, /api/server/stats
21. [x] **Dokumentacja v3.0** - STATUS_TRACKING_v3.md
22. [x] **Zmiana ID urządzenia** - moduł id_change.rs, endpoint POST /api/peers/:id/change-id
23. [x] **Dokumentacja ID Change** - docs/features/ID_CHANGE_FEATURE.md

### ✅ Ukończone (2026-02-11)
24. [x] **System i18n** - wielojęzyczność panelu web przez JSON
25. [x] **Moduł Flask i18n** - web/i18n.py z API endpoints
26. [x] **JavaScript i18n** - web/static/js/i18n.js client-side
27. [x] **Tłumaczenia EN/PL** - web/lang/en.json, web/lang/pl.json
28. [x] **Selector języka** - w sidebarze panelu
29. [x] **Dokumentacja i18n** - docs/development/CONTRIBUTING_TRANSLATIONS.md

### ✅ Ukończone (2026-02-17)
30. [x] **Security audit v2.3.0** - 3 Critical, 5 High, 8 Medium, 6 Low findings - all Critical/High fixed
31. [x] **CSRF protection** - double-submit cookie pattern with csrf-csrf
32. [x] **Session fixation prevention** - session regeneration after login
33. [x] **Timing-safe auth** - pre-computed dummy bcrypt hash for non-existent users
34. [x] **WebSocket auth** - session cookie required for upgrade
35. [x] **Trust proxy configurable** - TRUST_PROXY env var
36. [x] **RustDesk Client API** - dedicated WAN port 21121 with 7-layer security
37. [x] **TOTP 2FA** - two-factor authentication with otplib
38. [x] **Address book sync** - AB storage with address_books table
39. [x] **Operator role** - admin/operator role separation
40. [x] **Flask removed from scripts** - betterdesk.sh + betterdesk.ps1 updated
41. [x] **SSL certificate configuration** - new menu option in both scripts
42. [x] **README updated** - comprehensive update for v2.3.0
43. [x] **Web Remote Client fixed** - 5 Critical, 2 High, 3 Low bugs fixed (video_received ack, autoplay, modifier keys, Opus audio, timestamps, O(n²) buffer, seeking, mouse, cursor, i18n)

### 🔜 Do Zrobienia (priorytety)

#### Go Server — Security Fixes (Phase 1) ✅ COMPLETED 2026-02-28
1. [x] **H1**: Walidacja `new_id` w API `POST /api/peers/{id}/change-id` — `peerIDRegexp` validation added
2. [x] **H3**: Rate-limiting na `POST /api/auth/login/2fa` — `loginLimiter.Allow(clientIP)` + audit log
3. [x] **H4**: Short TTL (5min) dla partial 2FA token — `GenerateWithTTL()` method added to JWTManager
4. [x] **M1**: Escapowanie `%`/`_` w `ListPeersByTag` SQL LIKE pattern — `ESCAPE '\'` clause added
5. [x] **M4**: Rate-limiting na TCP signal connections — `limiter.Allow(host)` in `serveTCP()`
6. [x] **M6**: Walidacja klucza w config endpoints — `configKeyRegexp` (1-64 alnum, dots, hyphens)

#### Go Server — Protocol Fixes (Phase 2) ✅ COMPLETED 2026-02-28
7. [x] **M8**: `ConfigUpdate` w `TestNatResponse` (relay_servers, rendezvous_servers) — klienty ≥1.3.x
8. [x] **M2**: TTL/max-size dla `tcpPunchConns` sync.Map (DDoS protection) — 2min TTL + 10K cap
9. [x] **M3**: WebSocket origin validation (signal + relay) — `WS_ALLOWED_ORIGINS` env var
10. [x] **M7**: Relay idle timeout (io.Copy stale sessions) — `idleTimeoutConn` wrapper

#### Go Server — TLS Everywhere (Phase 3) ✅ COMPLETED 2026-02-28
11. [x] TLS wrapper for TCP signal (:21116) via `config.DualModeListener` (auto-detect plain/TLS)
12. [x] TLS wrapper for TCP relay (:21117) via `config.DualModeListener` (auto-detect plain/TLS)
13. [x] WSS (WebSocket Secure) for signal (:21118) and relay (:21119) via `ListenAndServeTLS`
14. [x] Fallback: accept both plain and TLS on same ports (first-byte 0x16 detection)
15. [x] Config: `--tls-signal`, `--tls-relay` flags + `TLS_SIGNAL=Y`, `TLS_RELAY=Y` env vars

#### Go Server — PostgreSQL Integration (Phase 4) ✅ COMPLETED 2026-02-28
16. [x] `db/postgres.go` — full `Database` interface implementation using `pgx/v5` (pgxpool, 25+ methods)
17. [x] `db/open.go` — detect `postgres://` DSN and dispatch to PostgreSQL driver
18. [x] Config: `DB_URL=postgres://user:pass@host:5432/betterdesk` env var support (already in LoadEnv)
19. [x] Connection pooling with `pgxpool` (configurable max conns via `pool_max_conns` DSN param)
20. [x] Replace `sync.RWMutex` with PostgreSQL row-level locking (tx + FOR UPDATE in ChangePeerID)
21. [x] `LISTEN/NOTIFY` for real-time event push between instances (ListenLoop, Notify, OnNotify)
22. [x] PostgreSQL schema with proper types (BOOLEAN, BYTEA, TIMESTAMPTZ, BIGSERIAL)
23. [ ] Integration tests for PostgreSQL backend (requires live PostgreSQL instance)

#### Go Server — Migration Tool (Phase 5) ✅ COMPLETED 2026-03-01
24. [x] `tools/migrate/` — SQLite → PostgreSQL migration binary (5 modes: rust2go, sqlite2pg, pg2sqlite, nodejs2go, backup)
25. [x] Support migrating from original RustDesk `db_v2.sqlite3` schema (`peer` table → `peers`) — auto-detection
26. [x] Support migrating from BetterDesk Go schema (full schema with users, api_keys, etc.) — sqlite2pg/pg2sqlite
27. [x] Support migrating Node.js console tables (peer → peers, users → users) — nodejs2go mode
28. [x] Preserve Ed25519 keys, UUIDs, ID history, bans, tags — full data preservation
29. [x] Reverse migration: PostgreSQL → SQLite (pg2sqlite mode)
30. [x] Integration with ALL-IN-ONE scripts (betterdesk.sh / betterdesk.ps1) — menu option M in both scripts

#### Node.js Console
31. [x] ~~Kompilacja binarek v3.0.0 z nowymi plikami źródłowymi (Rust legacy)~~ — OBSOLETE (Go server replaced Rust)
32. [x] WebSocket real-time push dla statusu — completed as #251 (Phase 38: `deviceStatusPush.js`)
33. [x] Dodać testy jednostkowe dla HTTP API — completed as #252 (Phase 38: 5 test suites, 41 tests)
34. [x] Deploy v2.3.0+ to production and test all new features

#### Node.js Console — Recent Changes (deployed 2026-02-28)
35. [x] **RustDesk Client API v2.0.0** — 3 phases: heartbeat/sysinfo/peers, audit/conn/file/alarm, groups/strategies
36. [x] **Security audit** — H-1 (rate limiter IP spoofing), H-2/H-3 (device verification), M-4/M-5/M-6 (validation)
37. [x] **Device detail panel** — Hardware tab (sysinfo), Metrics tab (live bars + history charts)
38. [x] **Copy ID fix** — selector `.device-id-copy` → `.copy-btn` with stopPropagation
39. [x] **22 new i18n keys** — EN + PL translations for device_detail section

#### Go Server — E2E Encryption Fix (Phase 6) ✅ COMPLETED 2026-03-01
40. [x] **E2E handshake**: Removed spurious `RelayResponse` confirmation from `startRelay()` (was breaking `secure_connection()` handshake)
41. [x] **SignIdPk NaCl format**: Fixed `sendRelayResponse` to use `SignIdPk()` NaCl combined format (64-byte sig + IdPk protobuf) instead of raw PK
42. [x] **PunchHoleResponse**: Fixed UDP PunchHoleRequest to send `PunchHoleResponse` (with pk field) instead of `PunchHoleSent`
43. [x] **TCP PunchHole fields**: Added relay_server, nat_type, socket_addr, pk, and is_local fields to TCP PunchHole forwarding
44. [x] **Relay confirmation removed**: Removed dead `confirmRelay()` from ws.go
45. [x] **Verified E2E**: Debug relay confirmed `Message.SignedId` + `Message.PublicKey` handshake between peers
46. [x] **Deployment path fix**: Discovered systemd ExecStart path mismatch (`/opt/betterdesk-go/` vs `/opt/rustdesk/`), all binaries now deployed to correct path

#### Go Server — TCP Signaling Fix (Phase 7) ✅ COMPLETED 2026-03-04
47. [x] **TCP PunchHoleRequest immediate response**: `handlePunchHoleRequestTCP` now sends immediate `PunchHoleResponse` with signed PK, socket_addr, relay_server, and NAT type — matching UDP handler behavior. Previously returned nil and waited for target, causing "Failed to secure tcp: deadline has elapsed" timeout for TCP signaling clients (logged-in users).
48. [x] **TCP ForceRelay handling**: Added `ForceRelay || AlwaysUseRelay` check to TCP path — returns relay-only PunchHoleResponse immediately, matching UDP's `sendRelayResponse` behavior.
49. [x] **TCP RequestRelay immediate response**: `handleRequestRelayTCP` now returns immediate `RelayResponse` with signed PK and relay server to TCP initiator — previously sent nothing and waited for target's RelayResponse.
50. [x] **WebSocket RequestRelay fix**: ws.go now uses `handleRequestRelayTCP` instead of UDP handler (`handleRequestRelay`) which was sending the response via UDP — unreachable by WebSocket clients.
51. [x] **Root cause**: RustDesk client uses TCP (not UDP) for signal messages when logged in (reliable token delivery). TCP handlers returned nil for online targets, forcing clients to wait for target responses that may never arrive (strict NAT, firewall, slow network). UDP handlers always sent immediate responses.

#### GitHub Issues Triage & Fixes (Phase 8) ✅ COMPLETED 2026-03-05
52. [x] **QR code fix (Issue #38)**: Inverted QR code colors in `keyService.js` — `dark: '#e6edf3'` → `'#000000'`, `light: '#0d1117'` → `'#ffffff'` for both `getServerConfigQR()` and `getPublicKeyQR()`
53. [x] **403 error page (Issue #38)**: Created `views/errors/403.ejs` — `requireAdmin` middleware was rendering non-existent template, causing crash → redirect to dashboard for operators
54. [x] **RustDesk Client API on Go server (Issue #38)**: Added `client_api_handlers.go` with RustDesk-compatible endpoints: `POST /api/login`, `GET /api/login-options`, `POST /api/logout`, `GET /api/currentUser`, `GET/POST /api/ab`. Fixes `_Map<String, dynamic>` Dart client error caused by sending login to Go server port 21114 which lacked `/api/login`
55. [x] **GetPeer live status (Issue #16)**: `handleGetPeer` now enriches response with `live_online` and `live_status` from in-memory peer map, matching `handleListPeers` behavior. Previously returned raw DB data without live status overlay
56. [x] **i18n: forbidden keys**: Added `errors.forbidden_title` and `errors.forbidden_message` to EN/PL/ZH translations
57. [x] **Chinese i18n verified (Issue #28)**: `zh.json` has 100% key coverage — no missing translations
58. [x] **Old Rust server removed from UI**: Settings page, serverBackend.js, settings.routes.js — all hbbsApi branching removed, hardcoded to BetterDesk Go server
59. [x] **Docker single-container**: New `Dockerfile` (multi-stage Go+Node.js+supervisord), `docker-compose.single.yml`, `docker/entrypoint.sh`, `docker/supervisord.conf`
60. [x] **DB auto-detection**: `dbAdapter.js` and `config.js` auto-detect PostgreSQL from `DATABASE_URL` prefix
61. [x] **Windows experimental labels**: Tier system in README, `.github/labels.yml`, PS1 banner

#### Go Server — Sysinfo/Heartbeat Endpoints (Phase 9) ✅ COMPLETED 2026-03-05
62. [x] **Hostname/Platform display (Issue #37)**: RustDesk client sends hostname/os/version via `POST /api/sysinfo` to signal_port-2 (21114). Go server was missing these endpoints — hostname/platform columns stayed empty.
63. [x] **UpdatePeerSysinfo DB method**: Added `UpdatePeerSysinfo(id, hostname, os, version)` to Database interface + SQLite + PostgreSQL implementations. Uses CASE WHEN to only overwrite with non-empty values.
64. [x] **POST /api/heartbeat**: Accepts `{id, cpu, memory, disk}`, verifies peer exists & not banned, updates status to ONLINE, requests sysinfo if hostname is empty. Response: `{modified_at, sysinfo: true/false}`.
65. [x] **POST /api/sysinfo**: Accepts full sysinfo payload, extracts hostname/platform/version, calls `UpdatePeerSysinfo()`. Response: plain text `"SYSINFO_UPDATED"` (activates PRO mode in client).
66. [x] **POST /api/sysinfo_ver**: Version check endpoint — returns SHA256 hash of stored sysinfo fields. Empty response triggers full sysinfo upload from client.
67. [x] **Auth middleware updated**: `/api/heartbeat`, `/api/sysinfo`, `/api/sysinfo_ver` added to public endpoint list (no auth required — client may not be logged in).
68. [x] **Audit logging**: Added `ActionSysinfoUpdated` and `ActionSysinfoError` audit actions with full details (hostname, os, version).

#### Node.js Console — Route Conflict Fix (Phase 10) ✅ COMPLETED 2026-03-08
69. [x] **Users page 401 error (Issue #42)**: Route conflict in `rustdesk-api.routes.js`: `GET /api/users` handler for RustDesk desktop client (Bearer token auth) was intercepting panel requests (session cookie auth), returning 401. Fixed by detecting absent Bearer token and calling `next('route')` to allow panel routes to handle the request.
70. [x] **Peers route conflict (Issue #42)**: Same fix applied to `GET /api/peers` — fallthrough to panel routes when no Bearer token present.

#### ALL-IN-ONE Scripts — Database Config Preservation (Phase 11) ✅ COMPLETED 2026-03-13
71. [x] **PostgreSQL→SQLite switch on UPDATE**: `betterdesk.sh` and `betterdesk.ps1` were overwriting `.env` with default SQLite config during UPDATE/REPAIR, losing PostgreSQL DSN. Added `preserve_database_config()` / `Preserve-DatabaseConfig` functions that read existing `.env` before reinstall.
72. [x] **betterdesk.sh fix**: Added `preserve_database_config()` after `detect_installation()` in `do_update()` and `do_repair()`. Reads `DB_TYPE` and `DATABASE_URL` from existing `.env`, sets `USE_POSTGRESQL` and `POSTGRESQL_URI` global vars.
73. [x] **betterdesk.ps1 fix**: Added `Preserve-DatabaseConfig` PowerShell function with same logic. Called in `Do-Update` and `Do-Repair` before any reinstallation.
74. [x] **Root cause**: `install_nodejs_console()` always created new `.env` based on `USE_POSTGRESQL` var which defaults to `false`. During UPDATE, this var was never set from existing config.

#### Docker Single-Container — Port 5000 Conflict Fix (Phase 13) ✅ COMPLETED 2026-03-15
75. [x] **Root cause (Issue #56)**: Go server `config.LoadEnv()` reads generic `PORT` env var for signal port. In Docker single-container, `PORT=5000` is intended for Node.js console but leaks into Go server, setting signal to :5000. Both processes fight for port 5000 → EADDRINUSE race condition.
76. [x] **config.go fix**: Added `SIGNAL_PORT` env var with higher priority than `PORT` — `SIGNAL_PORT` takes precedence, `PORT` only used as fallback.
77. [x] **supervisord.conf fix**: Added `SIGNAL_PORT="21116"` to Go server environment section.
78. [x] **entrypoint.sh fix**: Exports `SIGNAL_PORT=${SIGNAL_PORT:-21116}` before starting supervisord.
79. [x] **Dockerfile fix**: Added `ENV SIGNAL_PORT=21116` as default alongside `ENV PORT=5000`.
80. [x] **Multi-container NOT affected**: `docker-compose.yml` uses separate containers, no port conflict.

#### ALL-IN-ONE Scripts — IP Detection & Relay Fix (Phase 14) ✅ COMPLETED 2026-03-15
81. [x] **`get_public_ip: command not found` (Issue #58)**: Diagnostics function called undefined `get_public_ip` function at line 3348. Created reusable `get_public_ip()` function in all 3 scripts (`betterdesk.sh`, `betterdesk.ps1`, `betterdesk-docker.sh`). Function prefers IPv4 (`curl -4`) over IPv6 for relay compatibility.
82. [x] **DRY refactor**: All 4+ inline `curl ifconfig.me` patterns in `betterdesk.sh` and 5+ in `betterdesk-docker.sh` replaced with `get_public_ip()` calls. Single source of truth for IP detection.
83. [x] **Private/loopback IP warning**: `setup_services()` in `betterdesk.sh` and `Setup-Services` in `betterdesk.ps1` now warn when detected IP is private (10.x, 192.168.x, 172.16-31.x) or loopback (127.0.0.1). Remote relay connections will fail with private IPs.
84. [x] **`RELAY_SERVERS` env var override**: Both scripts now support `RELAY_SERVERS=YOUR.PUBLIC.IP sudo ./betterdesk.sh` to override auto-detected IP. Critical for servers behind NAT or with broken external IP detection.
85. [x] **Go server relay port normalization**: `GetRelayServers()` in `config/config.go` now auto-appends default relay port (21117) when `-relay-servers IP` is passed without port. Uses `net.SplitHostPort`/`net.JoinHostPort` for correct IPv6 handling.

#### Security Hardening — API + Installers (Phase 15) ✅ COMPLETED 2026-03-15
86. [x] **Go API WebSocket origin hardening**: Removed `InsecureSkipVerify: true` from `api/server.go` events WS endpoint and switched to safe defaults with optional `API_WS_ALLOWED_ORIGINS` allowlist in `config/config.go`.
87. [x] **Local-only Web panel by default**: Node.js config now binds panel to `127.0.0.1` by default (`HOST`), while keeping separate `API_HOST` for RustDesk client API exposure.
88. [x] **Install script SQL/interpolation hardening**: Added SQL literal escaping + PostgreSQL identifier validation in `betterdesk.sh`; replaced dangerous shell interpolation in Python/Node fallback password reset paths with environment-variable passing.
89. [x] **Credentials persistence hardening**: Plaintext `.admin_credentials` persistence is now opt-in via `STORE_ADMIN_CREDENTIALS=true` (default secure behavior: do not persist credentials files).
90. [x] **Dependency vulnerability fixes**: Updated Node override for `tar` in `web-nodejs/package.json`; `npm audit --omit=dev` now reports 0 vulnerabilities. Added Go toolchain hardening (`go.mod` toolchain + installer checks) to avoid vulnerable Go 1.26.0 stdlib.

#### Docker — API Key Auto-Generation (Phase 16) ✅ COMPLETED 2026-03-15
91. [x] **Root cause (Issue #59)**: Docker single-container never created `.api_key` file. Dashboard used public `/api/server/stats` (showed correct count), Devices page used protected `/api/peers` (401 → empty list). Node.js sent empty `X-API-Key` header because file didn't exist in volume.
92. [x] **Go server fix (`main.go`)**: `loadAPIKey()` now has 5-step lookup: (1) `API_KEY` env var, (2) `.api_key` in key dir, (3) `.api_key` in DB dir, (4) NEW: `server_config` table, (5) NEW: auto-generate 32-byte hex key → write to `.api_key` file + sync to DB.
93. [x] **Docker entrypoint fix (`docker/entrypoint.sh`)**: Generates API key before supervisord starts if `.api_key` file missing. Uses `openssl rand -hex 32` with `/dev/urandom` fallback. Also persists `API_KEY` env var to file if provided.
94. [x] **Node.js resilience (`betterdeskApi.js`)**: Axios 401 interceptor re-reads `.api_key` from disk once on auth failure. Handles race condition where Go server generates key after Node.js cached empty value at startup.

#### Go Server — Relay & Diagnostics Fixes (Phase 17) ✅ COMPLETED 2026-03-16
95. [x] **Public IP retry never activated**: `startIPDetectionRetry()` goroutine (60s ticker, retries `detectPublicIP()`) was defined in `signal/server.go` but never called from `Start()`. If initial public IP detection failed (e.g. external services unreachable at boot), `getRelayServer()` returned LAN IP or bare port — causing remote clients to fail relay with "Failed to secure tcp: deadline has elapsed". Fixed by adding `s.startIPDetectionRetry(s.ctx)` call in `Start()` before goroutine launches.
96. [x] **`/api/audit/conn` returns 400 for numeric IDs**: RustDesk client sends `host_id` as numeric (e.g., `1340238749`). Validation `typeof body.host_id !== 'string'` rejected it. Changed to `String()` coercion for `host_id`, `host_uuid`, and `peer_id` — accepts both string and numeric IDs.
97. [x] **Stale sysinfo log spam**: Heartbeat handler logged "Requesting sysinfo refresh from {id} (stale)" every ~15 seconds per device with no throttling. Added `shouldLogSysinfoRequest()` with Map-based 5-minute cooldown per device (auto-prune at 1000 entries). Sysinfo request to client still happens every heartbeat (functional behavior unchanged), only log message is throttled.

#### Go Server — Address Book & Issue Fixes (Phase 18) ✅ COMPLETED 2026-03-17
98. [x] **Address Book storage in Go server (Issue #57)**: Replaced stub `/api/ab` handlers with real implementation. Added `address_books` table (SQLite + PostgreSQL), `GetAddressBook`/`SaveAddressBook` methods to Database interface, full GET/POST handlers for `/api/ab`, `/api/ab/personal`, `/api/ab/tags`. RustDesk clients send AB to signal_port-2 (21114=Go), not Node.js (21121).
99. [x] **Settings password "password is required" (Issue #60)**: `settings.js` sent snake_case (`current_password`, `new_password`) but `auth.routes.js` expected camelCase (`currentPassword`, `newPassword`, `confirmPassword`). Fixed field names + added missing `confirmPassword`.
100. [x] **Password modal plaintext (Issue #60)**: `modal.js` `prompt()` only checked `options.type`, but `users.js` passed `inputType: 'password'`. Fixed modal to check both `options.type` and `options.inputType`.
101. [x] **Closed 12 resolved GitHub issues**: #59, #56, #52, #28, #54, #58, #19, #53, #61, #60, #57, #48 — all verified and closed with detailed resolution comments.

#### Go Server — Empty UUID & Relay Fix (Phase 19) ✅ COMPLETED 2026-03-18
102. [x] **Root cause: Empty UUID in relay (Issues #58, #63, #64)**: When hole-punch fails, RustDesk client sends `RequestRelay{uuid=""}` because `PunchHoleResponse` protobuf has no `uuid` field. Signal server propagated empty UUID to target and relay → relay rejected both connections. Fixed `handleRequestRelay()` (UDP) and `handleRequestRelayTCP()` (TCP) to generate `uuid.New().String()` when `msg.Uuid` is empty.
103. [x] **handleRelayResponseForward safety**: Added empty UUID warning + generation in `handleRelayResponseForward()` for target-initiated relay flow (last-resort safety net).
104. [x] **Relay server address validation**: `GetRelayServers()` in `config/config.go` now rejects entries with host < 2 characters (prevents `relay=a:21117` from invalid config).
105. [x] **Docker DNS resilience (Issue #62)**: Added retry logic (`|| { sleep 2 && apk add ...; }`) to all `apk add --no-cache` commands in `Dockerfile`, `Dockerfile.server`, and `Dockerfile.console` for transient DNS failures on AlmaLinux/CentOS.

#### ALL-IN-ONE Scripts — Installer Stability Fix (Phase 20) ✅ COMPLETED 2026-03-18
106. [x] **PostgreSQL→SQLite regression on UPDATE (CRITICAL)**: `setup_services()` in `betterdesk.sh` relied solely on ephemeral shell variables (`$USE_POSTGRESQL`, `$POSTGRESQL_URI`) for database config. If vars were lost between function calls, service files defaulted to SQLite. Added safety-net re-read from `.env` at start of `setup_services()`. Same fix applied to `Setup-Services` in `betterdesk.ps1`.
107. [x] **Hard-coded `/usr/bin/node` in systemd service**: `betterdesk-console.service` template used `ExecStart=/usr/bin/node server.js`. On systems with NodeSource/nvm/snap, node is at different path. Changed to dynamic detection via `command -v node`. Added `StandardOutput=journal`, `StandardError=journal`, `SyslogIdentifier=betterdesk-console` for visible error logs.
108. [x] **Auth.db + admin password destroyed on every UPDATE (CRITICAL)**: `install_nodejs_console()` unconditionally deleted `auth.db`, generated new admin password, new SESSION_SECRET, and created `.force_password_update` sentinel — destroying all user accounts, sessions, and TOTP configs on every update. Fixed: detect existing `.env` as UPDATE indicator; preserve auth.db, SESSION_SECRET, and admin password. Only generate fresh credentials on FRESH install. Same fix applied to `Install-NodeJsConsole` in `betterdesk.ps1` and `create_compose_file` in `betterdesk-docker.sh`.
109. [x] **Legacy betterdesk-api.service not cleaned up**: Script removed `rustdesksignal.service` and `rustdeskrelay.service` but not the old Flask `betterdesk-api.service`. Added cleanup in `setup_services()` (Linux) and NSSM `BetterDeskAPI` removal in `Setup-Services` (Windows). Fixes "Failed to determine user credentials: No such process" error.
110. [x] **PS1 `Do-Update` called `Setup-ScheduledTasks` instead of `Setup-Services`**: Windows update path used scheduled tasks fallback instead of NSSM services, inconsistent with `Do-Install` which correctly calls `Setup-Services`. Fixed to call `Setup-Services`.
111. [x] **PS1 `Repair-Binaries` checked `hbbs.exe` instead of `betterdesk-server.exe`**: Binary lock check referenced legacy Rust binaries. Updated to check `betterdesk-server.exe` with `hbbs.exe` fallback.
112. [x] **PS1 NSSM env missing DB_TYPE/DATABASE_URL**: NSSM `AppEnvironmentExtra` for console service did not include database type variables. Added `DB_TYPE` and `DATABASE_URL` propagation for PostgreSQL mode.
113. [x] **Docker: API key + auth.db regenerated on every update**: `create_compose_file()` unconditionally generated new API key, new admin password, and deleted auth.db from volume. Changed to preserve existing `.api_key` and `.admin_credentials` files; only wipe auth.db on fresh install.

#### Go Server & Installers — API TLS Separation Fix (Phase 21) ✅ COMPLETED 2026-03-18
114. [x] **Root cause: API auto-HTTPS breaking Node.js ↔ Go communication**: When `--tls-cert` and `--tls-key` flags were provided, `api/server.go` used `HasTLSCert()` to auto-enable HTTPS on API port 21114. Unlike signal (`--tls-signal`) and relay (`--tls-relay`) which had explicit opt-in flags, API TLS was automatic. With self-signed certs, Node.js sent `http://localhost:21114` to an HTTPS server → Go returned HTTP 400 ("client sent an HTTP request to an HTTPS server") → `getAllPeers` failed → 0 devices in panel.
115. [x] **`--tls-api` flag added to Go server**: New `TLSApi bool` field in `config.Config`, `APITLSEnabled()` method (`TLSApi || ForceHTTPS) && HasTLSCert()`), `--tls-api` CLI flag, `TLS_API=Y` env var. `api/server.go` changed from `HasTLSCert()` to `APITLSEnabled()`. API now stays HTTP unless explicitly opted in. `--force-https` implies `--tls-api`. Startup log shows correct HTTP/HTTPS scheme.
116. [x] **Installer scripts: self-signed → API stays HTTP**: `betterdesk.sh` and `betterdesk.ps1` now pass `-tls-api` only for proper certs (Let's Encrypt, custom), not for self-signed. `api_scheme` in systemd/NSSM env set to `http` for self-signed, `https` only when `-tls-api` active.
117. [x] **SSL config menu updated**: Option C (SSL configuration) in both scripts now correctly adds/removes `-tls-api` from Go server service args. Self-signed: signal/relay TLS only, API HTTP. Proper cert: full TLS including API.
118. [x] **.env API URL no longer blindly switched to https://**: Self-signed cert generation no longer changes `BETTERDESK_API_URL=http://` to `https://` in `.env`. Only SSL config with proper certs or explicit `--tls-api` triggers HTTPS API URLs.
119. [x] **Diagnostics updated**: `betterdesk.sh` diagnostics now checks for `--tls-api` or `--force-https` in service args (not just `--tls-cert`) to determine API scheme.
120. [x] **Stale `betterdesk-go.service` cleanup**: Added removal of `betterdesk-go.service` (from manual installs with wrong credentials) to `setup_services()` legacy cleanup, `legacy_services` array, and uninstall section.
121. [x] **Migration tool auto-compilation**: `migrate_sqlite_to_postgresql()` now tries to compile migration tool from source when Go is available and binary is not found. Also validates binary supports `-mode` flag (detects outdated binaries).
122. [x] **Migration tool rebuilt**: `tools/migrate/migrate-linux-amd64` rebuilt with current source code supporting `-mode`, `-src`, `-dst`, `-node-auth` flags.

#### Web Remote Client — Cursor, Video & Input Fix (Phase 22) ✅ COMPLETED 2026-03-18
123. [x] **Cursor ImageData crash (Critical)**: `renderer.js` `updateCursor()` called `new ImageData(new Uint8ClampedArray(pixelData), w, h)` without validating `pixelData.length === w * h * 4`. Protobuf cursor data can be zstd-compressed (magic `28 b5 2f fd`), truncated, or have padding. Added: zstd detection + skip, length validation (skip if too short, truncate if too long), full try/catch wrapper. Prevents `InvalidStateError: input data length is not a multiple of 4` crash.
124. [x] **Unhandled cursor promise rejection**: `_dispatchMessage()` in `client.js` called async `renderer.updateCursor()` without `.catch()` — unhandled promise rejections from ImageData errors polluted console. Added `.catch(() => {})` wrapper.
125. [x] **JMuxer per-frame seek stutter**: `_decodeFallback()` in `video.js` seeked to live edge (`currentTime = end - 0.01`) on every frame when buffer latency exceeded 0.15s. Constant micro-seeks caused playback stutter. Increased threshold from 0.15s to 0.5s and seek offset to 0.02s — lets MSE play naturally, only intervenes when significantly behind.
126. [x] **Health check too slow**: `_startHealthCheck()` interval reduced from 2000ms to 1000ms. Hard-seek threshold from 1.5s to 0.8s. Speed-up threshold from 0.3s to 0.15s. Playback rate from 1.05 to 1.15 for faster catch-up. `_recoverVideo()` threshold from 0.3s to 0.2s.
127. [x] **Focus management after login**: `handleLoginSuccess()` in `remote.js` now calls `passwordInput.blur()` to remove focus from hidden password input. `handleSessionStart()` explicitly calls `canvas.focus()`. Prevents `_isInputFocused()` guard in `input.js` from blocking keyboard events when hidden password input retains focus.
128. [x] **`.streaming` CSS class**: `handleStateChange()` in `remote.js` adds/removes `.streaming` class on `viewerContainer`. Enables CSS rule `.viewer-container:not(.streaming) #remote-canvas { cursor: default }` — shows system cursor when not streaming, hides when streaming.
129. [x] **Dynamic codec negotiation**: `buildLoginRequest()` in `protocol.js` now detects `VideoDecoder` (WebCodecs) and `JMuxer` availability. HTTPS: reports VP9+H264+AV1+VP8 with Auto preference. HTTP: reports H264-only with H264 preference. Gives peer more encoding options on HTTPS.
130. [x] **FPS option after login**: `_startSession()` in `client.js` sends `customFps` option as Misc message after login. Default reduced from 60 to 30 fps for stability. Helps peer establish target framerate without relying solely on `video_received` ack timing.

#### Go Server & Node.js — Device Management Fix (Phase 23) ✅ COMPLETED 2026-03-18
131. [x] **IsPeerSoftDeleted interface + impl**: Added `IsPeerSoftDeleted(id string) (bool, error)` to `db/database.go` interface. Implemented in both `sqlite.go` and `postgres.go` — queries `soft_deleted` column for deleted device detection.
132. [x] **Zombie device prevention (Issues #65, #64, #38)**: Signal handler now checks `IsPeerSoftDeleted()` after `IsPeerBanned()` in both `handleRegisterPeer()` and `processRegisterPk()`. Deleted devices cannot re-register, preventing "zombie" devices from reappearing after admin deletion.
133. [x] **UpdatePeerFields method**: Added `UpdatePeerFields(id string, fields map[string]string) error` to Database interface + implementations. Supports dynamic partial updates for `note`, `user`, `tags` fields with SQL-safe allowed-key validation.
134. [x] **PATCH /api/peers/{id} endpoint**: New REST endpoint in `api/server.go` for partial peer updates. Accepts JSON body `{"note": "...", "user": "...", "tags": "..."}`. Used by Node.js panel instead of direct SQLite writes.
135. [x] **Tags type mismatch fix (Issues #65, #38)**: `handleSetPeerTags` in `api/server.go` now accepts both JSON string (`"tag1,tag2"`) and array (`["tag1","tag2"]`) using `json.RawMessage`. Fixes 400 errors when panel sends array format.
136. [x] **Notes routed through Go API**: `serverBackend.js` `updateDevice()` now calls Go server's `PATCH /api/peers/{id}` endpoint instead of writing directly to Node.js SQLite. Ensures notes/user/tags stored in Go server's `db_v2.sqlite3`.
137. [x] **Tag serialization fix**: `betterdeskApi.js` `setPeerTags()` now sends tags as array in request body. Added `updatePeer()` method for PATCH requests.
138. [x] **auth.db cleanup on delete**: `devices.routes.js` delete handler now calls `db.cleanupDeletedPeerData(id)` to remove user linkages from auth.db when device is deleted. Implemented `cleanupDeletedPeerData()` in `dbAdapter.js` for both SQLite and PostgreSQL.
139. [x] **Relay UUID tracking (Issues #65, #64)**: Old RustDesk clients respond with empty UUID in `RelayResponse`. Added `pendingRelayUUIDs sync.Map` to track UUIDs sent to targets in `RequestRelay`/`PunchHole`. When target responds with empty UUID, `handleRelayResponseForward` recovers original UUID from store. Fixes relay pairing failures.
140. [x] **ActionPeerUpdated audit**: Added `ActionPeerUpdated` constant to `audit/logger.go` for tracking peer field updates.
141. [x] **getPendingUUID retry support**: Changed `getPendingUUID()` from `LoadAndDelete` to `Load` — UUID now remains available for multiple retry attempts from target device. Cleanup handled by existing ticker goroutine (2-min TTL).

#### Go Server — Peer Metrics Persistence (Phase 24) ✅ COMPLETED 2026-03-19
142. [x] **PeerMetric struct**: Added `PeerMetric` struct to `db/database.go` (ID, PeerID, CPU, Memory, Disk, CreatedAt) for heartbeat metrics storage.
143. [x] **Database interface methods**: Added `SavePeerMetric()`, `GetPeerMetrics()`, `GetLatestPeerMetric()`, `CleanupOldMetrics()` to Database interface.
144. [x] **peer_metrics table (SQLite)**: Added `peer_metrics` table to `sqlite.go` Migrate() with indexes on peer_id and created_at. Implemented all 4 metric methods.
145. [x] **peer_metrics table (PostgreSQL)**: Added `peer_metrics` table to `postgres.go` Migrate() with BIGSERIAL PK and TIMESTAMPTZ. Implemented all 4 metric methods.
146. [x] **handleClientHeartbeat extended**: Now parses `cpu`, `memory`, `disk` float64 fields from request body and calls `SavePeerMetric()` when any value > 0.
147. [x] **GET /api/peers/{id}/metrics endpoint**: New API endpoint returns historical metrics for a peer with configurable limit (default 100, max 1000). Enables Node.js console to fetch metrics from Go server.

#### Docker — GitHub Container Registry & Quick Start (Phase 25) ✅ COMPLETED 2026-03-19
148. [x] **GitHub Actions workflow**: `.github/workflows/docker-publish.yml` — automatically builds and publishes images to `ghcr.io/unitronix/betterdesk-server`, `ghcr.io/unitronix/betterdesk-console`, `ghcr.io/unitronix/betterdesk` on push to main. Multi-arch: linux/amd64 + linux/arm64.
149. [x] **docker-compose.quick.yml**: Pre-built images from ghcr.io — no build required. One-liner install: `curl ... && docker compose up -d`.
150. [x] **DOCKER_QUICKSTART.md**: 30-second quick start guide with troubleshooting, configuration options, and client setup instructions.
151. [x] **docker-compose.yml updated**: Header now points to quick.yml for beginners.
152. [x] **README.md updated**: Docker section now starts with Quick Start (no build required).

#### ALL-IN-ONE Scripts — PS1 Compatibility & Upgrade Detection (Phase 26) ✅ COMPLETED 2026-03-19
153. [x] **PS1 `RandomNumberGenerator::Fill` crash (Issue #38)**: `[System.Security.Cryptography.RandomNumberGenerator]::Fill()` is a .NET 6+ static method unavailable in Windows PowerShell 5.1 (.NET Framework 4.x). Changed to `RNGCryptoServiceProvider.GetBytes()` instance method which works on both .NET Framework 4.x and .NET 6+. Fixes API key generation failure → 0 devices in panel on fresh Windows install.
154. [x] **Rust→Go upgrade detection (Issues #66, #38)**: `Do-Update` (PS1) and `do_update()` (bash) now detect `SERVER_TYPE=rust` (legacy hbbs/hbbr) and warn user that Rust→Go is a major architecture change requiring fresh installation. In auto mode, redirects to `Do-Install`/`do_install` automatically. In interactive mode, prompts user to confirm fresh install (recommended) or continue with partial update. Prevents broken upgrade path from v1.5.0 (Rust) to v2.3.0+ (Go).

#### Go Server — ForceRelay UUID Fix & Docker GHCR (Phase 27) ✅ COMPLETED 2026-03-19
155. [x] **ForceRelay TCP UUID mismatch (Issue #66)**: `handlePunchHoleRequestTCP` ForceRelay path returned `RelayResponse{uuid=SERVER_UUID}` directly to TCP initiator. Some RustDesk client versions ignore the UUID from `RelayResponse` received in response to `PunchHoleRequest`, generate their own UUID, and connect to relay with it — while the target connects with the server's UUID. Relay pairing always failed (different UUIDs). **Fix**: ForceRelay TCP now returns `PunchHoleResponse{nat_type=SYMMETRIC}` instead of `RelayResponse`. Client sees SYMMETRIC NAT → sends `RequestRelay{uuid=CLIENT_UUID}` on same TCP connection → `handleRequestRelayTCP` forwards CLIENT_UUID to target → both sides use same UUID → relay pairing succeeds.
156. [x] **Relay diagnostic logging**: Added `log.Printf` with UUID and relay server in `handleRequestRelayTCP` and `handleRequestRelay` (UDP) return paths for better relay pairing diagnostics.
157. [x] **Docker GHCR "denied" error (Issue #67)**: Pre-built images on `ghcr.io/unitronix/betterdesk-*:latest` not available — workflow never triggered or packages are private. Added troubleshooting section to `DOCKER_QUICKSTART.md` (3 solutions: build locally, trigger workflow, authenticate). Added fallback comment to `docker-compose.quick.yml`. Added package visibility reminder to CI workflow summary step.

#### CDAP v0.2.0 — Device Revocation & Schema (Phase 28) ✅ COMPLETED 2026-03-20
158. [x] **CDAP schema columns**: Added `device_type TEXT DEFAULT ''` and `linked_peer_id TEXT DEFAULT ''` to `peers` table in both SQLite (`db/sqlite.go`) and PostgreSQL (`db/postgres.go`) via automatic column migration (v2.5.0). Updated all SELECT/Scan queries (GetPeer, ListPeers, ListPeersByTag, ChangePeerID) and `UpdatePeerFields` allowed keys.
159. [x] **GetLinkedPeers**: New `GetLinkedPeers(id string) ([]*Peer, error)` method on Database interface + both implementations. Queries peers where `linked_peer_id = id`.
160. [x] **Device revocation endpoint**: Enhanced `DELETE /api/peers/{id}` with `?revoke=true` (auto BlockID + disconnect active connections) and `?cascade=true` (delete all linked devices). Publishes `EventPeerRevoked` event and logs `ActionPeerRevoked` audit action.
161. [x] **Connection teardown on Remove**: `peer.Entry.CloseConnections()` method closes TCP and WebSocket connections. Called from `peer.Map.Remove()` and `CleanExpired()` — revoked devices are disconnected immediately.
162. [x] **Panel revocation UI**: Delete modal in `devices.js` includes "Revoke device" checkbox with hint text. Routes through `devices.routes.js` → `serverBackend.js` → `betterdeskApi.js` with `revoke`/`cascade` query params.
163. [x] **i18n keys**: Added `revoke_option`, `revoke_hint`, `revoke_success` to EN, PL, ZH translation files.
164. [x] **Deployed & verified**: Binary deployed to production server (PostgreSQL backend). Automatic migration confirmed — `device_type` and `linked_peer_id` columns present. API returns peers correctly. 5 devices online, 53 total.

#### CDAP v0.3.0 — Panel Widget Rendering (Phase 29) ✅ COMPLETED 2026-03-20
165. [x] **cdap/api.go**: REST-helper methods on Gateway — `GetDeviceInfo()`, `GetDeviceManifest()`, `GetDeviceWidgetState()`, `IsConnected()`, `SendCommandJSON()`, `ListConnectedDevices()`. New `DeviceInfo` struct for REST responses.
166. [x] **api/cdap_handlers.go**: 6 HTTP handlers — `handleCDAPStatus`, `handleCDAPListDevices`, `handleCDAPDeviceInfo`, `handleCDAPDeviceManifest`, `handleCDAPDeviceState`, `handleCDAPSendCommand`. Uses `commandCounter atomic.Int64` for unique command IDs. Returns 503 when CDAP disabled.
167. [x] **api/server.go CDAP integration**: Added `cdapGw` field, `SetCDAPGateway()` method, 6 CDAP mux routes. `CDAPConnected` bool in `peerResponse` for both `handleListPeers` and `handleGetPeer`. CDAP overlay: if device connected via CDAP but not signal, shown as online.
168. [x] **main.go CDAP wiring**: Gateway created before API server, `SetCDAPGateway()` called before `Start()`, gateway started after API.
169. [x] **betterdeskApi.js CDAP methods**: 6 async methods — `getCDAPStatus`, `getCDAPDevices`, `getCDAPDeviceInfo`, `getCDAPDeviceManifest`, `getCDAPDeviceState`, `sendCDAPCommand`.
170. [x] **cdap.routes.js**: Page route `GET /cdap/devices/:id` + 6 API proxy routes. Uses `requireAuth` + `requireRole('operator')` for command sending.
171. [x] **routes/index.js**: Registered `cdapRoutes` as `router.use('/', cdapRoutes)`.
172. [x] **cdap-device.ejs**: Device detail page with header (name, type, version, uptime, status), offline banner, widget grid, empty state, command log panel.
173. [x] **cdap-widgets.js**: Widget renderer supporting 8 types (toggle, gauge, button, led, text, slider, select, chart). State polling every 3s. Info polling every 10s. User interaction guard (`_userInteracting` flag) prevents state overwrite during input. Grouped by category.
174. [x] **cdap-commands.js**: Command sender with per-widget cooldown (1s), confirmation dialog integration, command log (max 50 entries), toast notifications.
175. [x] **cdap.css**: Full widget styling — grid layout, toggle switch, gauge bar with danger/warning thresholds, LED indicator, slider with range labels, select dropdown, chart bars, command log panel. Responsive breakpoints. Dark theme CSS variables.
176. [x] **i18n keys**: 22 CDAP keys added to EN, PL, ZH translation files (device_detail, loading, connected, disconnected, widgets, commands, etc.).
177. [x] **Deployed & verified**: Go binary + Node.js files deployed. Server running, console active. CDAP routes return 302 (auth redirect) for unauthenticated, 401 for API without key — both correct.

#### Devices Page UI Redesign (Phase 30) ✅ COMPLETED 2026-03-20
178. [x] **devices.ejs rewrite**: Removed 280px sidebar layout. New single-column layout with horizontal scrollable folder chips (`.folder-chip` buttons), unified toolbar (search + segmented filter pills + column visibility toggle), slim table with 7 columns (id, hostname, device_type, platform, last_online, status, actions), kebab menu (`more_vert` icon) replacing 5 inline action buttons, mobile bottom sheet overlay for phone kebab menu.
179. [x] **devices.css rewrite**: ~780 lines. 4 responsive breakpoints: ≤1024px (hide device_type), ≤768px (hide platform+last_online, full-width search, icon-only buttons), ≤600px (card-style rows via CSS grid 2-col, hidden thead, fixed bottom sheet kebab with overlay), ≤400px (chip labels hidden, compact filters). Folder chip styles with hover-reveal edit/delete actions. Kebab dropdown with color-coded menu items.
180. [x] **devices.js updates**: `renderDevices()` outputs new HTML template with `.device-status-dot`, `.kebab-wrapper`/`.kebab-btn`/`.kebab-menu`. `renderFolders()` changed from `.folder-item` divs to `.folder-chip` buttons with `.chip-action` edit/delete. `attachRowEventListeners()` handles kebab toggle + menu item actions. Added `initKebabGlobalClose()` + `closeAllKebabMenus()`. Updated all selectors: `.folder-item` → `.folder-chip` in `selectFolder()`, `updateFolderCounts()`, `initFolders()`, `attachFolderDropEvents()`. Double-click guard updated from `.action-btn`/`.drag-handle` to `.kebab-wrapper`.
181. [x] **Deployed & verified**: All 3 files deployed to production server. Console returns 302 (service running). Responsive layout active.

#### Security & Installer Fixes (Phase 31) ✅ COMPLETED 2026-03-20
182. [x] **API TLS breaking clients (Issues #70, #71)**: Fresh install with proper SSL certs added `-tls-api -force-https` → API port 21114 HTTPS-only → RustDesk clients (HTTP only) get 400 → 0 devices. Fix: removed `-tls-api -force-https` from betterdesk.sh + betterdesk.ps1 for ALL cert types. `config.go`: `ForceHTTPS` no longer implies `APITLSEnabled()`. SSL config menu: always removes `-tls-api`/`-force-https`. API URLs always HTTP.
183. [x] **Password `$` escaping in systemd (Issue #68)**: systemd interprets `$` as variable substitution in ExecStart and Environment directives. Admin password and PostgreSQL URL now escaped `$` → `$$` before writing to `.service` files. Auto-generated passwords (alphanumeric) unaffected.
184. [x] **Port CONFLICT false positive**: `ss -tlnp` shows `MainThread` instead of `node` on some Linux systems (Ubuntu 24.04+). Added `MainThread` to expected process patterns for ports 5000 and 21121.

#### Web Remote Client — Mouse, Quality & FPS Fix (Phase 32) ✅ COMPLETED 2026-03-21
185. [x] **Mouse click fix (Critical)**: RustDesk parses mouse mask as `button = mask >> 3; type = mask & 7`. Web client sent flat values (mask=1 for left click → `button = 1>>3 = 0` = no button). Hover worked because mask=0 is correct for both formats. Fixed `input.js`: replaced flat values with `TYPE | (BUTTON << 3)` encoding (left click = `1|(1<<3)=9`, right click = `1|(2<<3)=17`, etc.). Added static constants `MOUSE_TYPE_DOWN=1`, `MOUSE_TYPE_UP=2`, `MOUSE_TYPE_WHEEL=3`, `MOUSE_BUTTON_LEFT=1`, `MOUSE_BUTTON_RIGHT=2`, `MOUSE_BUTTON_MIDDLE=4`.
186. [x] **Image quality fix**: `buildLoginRequest` in `protocol.js` hardcoded `imageQuality: Balanced`. Changed to configurable with default `Best`. `remote.js` passes `imageQuality: 'Best'` in constructor.
187. [x] **FPS fix**: Login used `customFps: opts.fps || 30` despite wanting 60fps. Changed default to 60. `client.js` `_startSession()` now sends both `customFps` and `imageQuality` options. `authenticate()` passes `fps: 60` and `imageQuality: 'Best'`.
188. [x] **Beta banner**: Replaced large orange "WIP" banner in `remote.ejs` with slim blue "Beta" banner with dismiss button.

#### CDAP Full-Stack — Audio, Clipboard, Cursor, Quality, Codec, Multi-Monitor (Phase 33) ✅ COMPLETED 2026-03-21
189. [x] **clipboard.go rewrite**: Fixed all field mismatches (sync.Map Load, DeviceConn.WriteMessage, session.browser, session.DeviceID, context.Background(), gw.auditAction()). Bidirectional browser↔device clipboard sync with format detection.
190. [x] **audio.go**: Full audio session management (~230 lines). AudioSession struct, AudioStartPayload (codec/sample_rate/channels/direction), AudioFramePayload (codec/data/timestamp/duration/sequence). StartAudioSession checks "audio" capability on device manifest. HandleAudioFrame/RelayAudioInput/EndAudioSession.
191. [x] **media_control.go**: Cursor rendering, adaptive quality, codec negotiation, multi-monitor, key exchange relay, keyframe requests (~320 lines). CursorUpdatePayload (format/width/height/hotspot_x/y/data/cursor_id/hidden), QualityReportPayload (bandwidth_kb/latency_ms/frame_loss/fps), computeQualityAdjustment (adaptive), CodecOffer/Answer relay, MonitorList/MonitorSelect, HandleKeyExchange, RelayKeyframeRequest.
192. [x] **gateway.go + handler.go integration**: Added audioSessions sync.Map. 7 new message cases in messageLoop: audio_frame, audio_end, clipboard_update, key_exchange, cursor_update, codec_answer, monitor_list. handleAudioFrame/handleAudioEnd in handler.go.
193. [x] **cdap_handlers.go extensions**: Desktop handler: 6 new switch cases (clipboard_set, quality_report, codec_offer, key_exchange, keyframe_request, monitor_select). Video handler: 4 new switch cases (quality_report, codec_offer, key_exchange, keyframe_request). New handleCDAPAudio WS handler (~100 lines) with init/ready/audio_input/close protocol.
194. [x] **server.go audio route**: `GET /api/cdap/devices/{id}/audio` with operator role requirement.
195. [x] **cdapMediaProxy.js audio entry**: Added audio channel to DRY proxy factory (subprotocol: cdap-audio, minRole: operator).
196. [x] **cdap-audio.js** (~310 lines, NEW): Web Audio API browser client. PCM 16-bit decode + Opus via decodeAudioData. Microphone capture via getUserMedia + ScriptProcessorNode. Volume/mute control, RMS level meter. WS init/ready/audio_frame/error/end protocol. Public API: CDAPAudio.open/close/isActive/setVolume/toggleMute/isMuted.
197. [x] **cdap-desktop.js rewrite** (~500 lines): Cursor rendering (PNG/RGBA format, LRU cache 50, hidden cursor), clipboard sync (navigator.clipboard API, paste events, clipboard indicator), quality reporting (5s interval, bandwidth/latency/frame_loss/fps), codec negotiation (sendCodecOffer on ready), multi-monitor (select UI in toolbar), keyframe requests.
198. [x] **cdap-video.js rewrite** (~280 lines): Quality reporting (5s interval), codec negotiation, keyframe request, frame byte/drop tracking.
199. [x] **cdap-widgets.js updates**: Audio widget renderer (status indicator, level meter, mute/connect buttons), desktop toolbar with clipboard indicator, audio connect/mute event listeners.
200. [x] **cdap.css** (~170 lines added): Audio widget styles (streaming/connecting/disconnected status, level meter with color thresholds), desktop toolbar, clipboard indicator (fade animation), monitor selector, .cdap-widget-md grid span.
201. [x] **i18n**: 7 new keys in EN/PL/ZH: connect_audio, audio_connecting, audio_streaming, clipboard_in, clipboard_out, monitor_select, keyframe_request, quality_auto.
202. [x] **Deployed & verified**: Go binary (28MB) + 10 Node.js files deployed to 192.168.0.110. Both services active. CDAP endpoint returns JSON, console returns 302 (auth redirect) — all correct.

#### Native BetterDesk Agent — Go Binary (Phase 34) ✅ COMPLETED 2026-03-21
203. [x] **betterdesk-agent/main.go**: CLI entry point with 14 flags, signal handling (SIGINT/SIGTERM), graceful shutdown.
204. [x] **agent/config.go**: Config struct + JSON/env loading + Validate(). Supports `server`, `auth_method` (api_key/device_token/user_password), `device_id`, `device_name`, `device_type`, `tags`, `terminal`, `file_browser`, `clipboard`, `screenshot`, `file_root`, `heartbeat_sec`, `reconnect_sec`, `log_level`.
205. [x] **agent/agent.go** (~750 lines): Core agent — WebSocket connect, CDAP auth, manifest registration, heartbeat loop with system metric → widget_values mapping (sys_cpu, sys_memory, sys_disk, sys_hostname, sys_uptime), message dispatch for 20+ CDAP message types (command, terminal_start/input/resize/kill, file_list/read/write/delete, clipboard_get/set, screenshot_capture, state_update, bulk_update, alert_ack, ping).
206. [x] **agent/system.go**: gopsutil metrics (CPU 1s sample, Memory, Disk root), SystemInfo (hostname/os/platform/version/arch/uptime/total_memory/total_disk), live Uptime() method.
207. [x] **agent/manifest.go**: CDAP manifest builder — device descriptor, capabilities (telemetry, commands, remote_desktop, file_transfer, clipboard), 9 system widgets (3 gauges, 2 text, 1 terminal, 1 file_browser, 1 button, 1 clipboard text), `heartbeat_interval` field.
208. [x] **agent/terminal_{unix,windows}.go**: Cross-platform terminal — creack/pty on Unix, cmd.exe StdinPipe/StdoutPipe on Windows.
209. [x] **agent/filebrowser.go**: safePath() path traversal protection, ListDirectory, ReadFileChunk (base64, 1MB max), WriteFileChunk (base64 decode), DeletePath.
210. [x] **agent/clipboard.go**: Cross-platform clipboard via OS commands (xclip/xsel/pbcopy/powershell).
211. [x] **agent/screenshot_{unix,windows}.go**: Platform-specific screenshot capture (screencapture/import/scrot on Unix, System.Drawing on Windows).
212. [x] **install/install.sh**: Linux systemd installer with ProtectSystem=strict, PrivateTmp, NoNewPrivileges security hardening.
213. [x] **install/install.ps1**: Windows NSSM service installer.
214. [x] **Protocol mismatches fixed**: terminal_output (not terminal_data), terminal_end (not terminal_close), file_write_response (not file_write_ack), file_delete_response (not file_delete_ack), flat widget fields (label/group, not nested config), heartbeat_interval (not heartbeat).
215. [x] **Deployed & verified**: Binary on 192.168.0.110, device_id=CDAP-6A9A5452, type=os_agent, 9 widgets, heartbeat=15s, telemetry flowing (CPU/Memory/Disk/Hostname/Uptime). CDAP API key created via REST (`POST /api/keys`), `api_keys` table entry active.

#### Bridge Ecosystem SDK — Python + Node.js + Reference Bridges (Phase 35) ✅ COMPLETED 2026-03-21
216. [x] **sdks/python/**: betterdesk-cdap v1.0.0 — CDAPBridge async class (~330 lines), Widget dataclass + 9 factory helpers, Message dataclass, all CDAP constants. Deps: websockets>=12.0.
217. [x] **sdks/nodejs/**: betterdesk-cdap v1.0.0 — CDAPBridge extends EventEmitter (~300 lines), Widget class + factory helpers, protocol constants. Dep: ws ^8.18.0. Smoke test verified.
218. [x] **bridges/modbus/**: Modbus TCP/RTU bridge (~200 lines) — register polling, data type encode/decode, write-back commands. Dep: pymodbus>=3.6.0.
219. [x] **bridges/snmp/**: SNMP v2c/v3 bridge (~200 lines) — OID polling, timetick formatting, counter rate computation. Dep: pysnmplib>=5.0.0.
220. [x] **bridges/rest-webhook/**: REST polling + aiohttp webhook listener (~230 lines) — JMESPath-lite extraction, configurable polling intervals. Dep: aiohttp>=3.9.0.
221. [x] **sdks/README.md + bridges/README.md**: Architecture overview, quick start, bridge creation guide.
222. [x] **WebSocket path fixed**: All SDKs, bridges, agent, and install scripts updated from `/ws` to `/cdap` (27 replacements across 14 files).

#### Desktop Widget Dashboard — Sidebar & i18n Fix (Phase 36) ✅ COMPLETED 2026-03-25
223. [x] **Sidebar navigation duplication**: Removed 12 duplicated nav items from widget sidebar that were identical to topnav. Sidebar now only has widget-specific tools: home, add widget, wallpaper, edit layout, reset layout, help.
224. [x] **`desktop.label_uptime` i18n key missing**: Server Info widget showed raw key `desktop.label_uptime: 26m` because `label_uptime` key did not exist (only `label_uptime_prefix`). Added `label_uptime` to EN/PL/ZH.
225. [x] **Missing i18n keys**: Added `action_add_widget` and `label_merged_server_info` to EN/PL/ZH locale files.
226. [x] **Canvas area calculation**: Fixed `getCanvasArea()` fallback dimensions to account for new sidebar width.

#### BetterDesk Desktop Client — Single Instance Fix (Phase 37) ✅ COMPLETED 2026-03-25
227. [x] **Dual process conflict**: Old elevated process (PID from autostart) could not be killed by new MSI install. Two tray icons, two WebSocket connections, stale state. User clicks on old tray → old process responds → nothing works.
228. [x] **`tauri-plugin-single-instance` added**: Second launch detects existing instance via Windows mutex, shows existing window instead of creating duplicate. Verified: only 1 process regardless of launch count.
229. [x] **i18n imports**: Added `t()` import from `../lib/i18n` to all 19 TSX components (6 were missing).

#### BetterDesk Desktop Client & Web Console — Chat, Remote, Operator, i18n, WS Push (Phase 38) ✅ COMPLETED 2026-03-26

##### 🔴 CRITICAL — Chat System Fixed
230. [x] **Chat shows "Disconnected"**: Root cause: `chatRelay.js` received `hello` frame but never sent acknowledgment (`case 'hello': break;` was a no-op). Rust client expected confirmation. Fixed: server now sends `welcome` ack with capabilities and server_time. Rust client handles `welcome` and `status` frame types.
231. [x] **Chat window opens blank**: ChatWindow.tsx was properly wired with event listeners. The blank state was caused by #230 — server never confirmed connection, so client showed disconnected. Fixed by #230.
232. [x] **Chat contacts/groups always empty**: `get_contacts` handler returned nothing when Go API was unavailable. Fixed: fallback contacts (operator + connected agents) now returned even without Go persistence. Initial agent connection also sends fallback contacts.

##### 🔴 CRITICAL — Web Remote Client Performance Fixed
233. [x] **Max 9 FPS from web console**: Fixed `video_received` ack timing — now sent BEFORE decoding (was after) for better pipelining. Added stall recovery: auto-requests `refreshVideo` keyframe if no frames arrive for 5 seconds. JMuxer fallback on HTTP remains a limitation (WebCodecs requires HTTPS).
234. [x] **No remote desktop control (mouse/keyboard)**: `_isInputFocused()` in `input.js` was blocking keyboard events when hidden password input retained focus after login. Fixed: now ignores hidden/invisible inputs (`el.offsetParent === null`). Mouse encoding was correct from Phase 32.
235. [x] **Video blurry/unstable on fullscreen**: `renderer.js` `resize()` now triggers `onResizeRefresh` callback which sends `refreshVideo` keyframe request. Peer sends fresh keyframe after fullscreen toggle, eliminating blur from stale P-frames.
236. [x] **Video freezes after 30-60 seconds**: Health check in `video.js` now trims MSE `SourceBuffer` when buffer exceeds 2 seconds via `sb.video.remove(start, end - 1.0)`. Prevents SourceBuffer overflow that caused freeze.

##### 🟡 HIGH — Desktop Client GUI Functions (Partially Fixed)
237. [x] **RemoteView basic JPEG viewer**: Added `start_remote_viewer` Tauri command — connects to management WS (`/ws/bd-mgmt/{device_id}`), receives JPEG binary frames, base64 encodes and emits to frontend. `RemoteView.tsx` now listens for `remote-viewer-frame` events and renders JPEG frames on canvas. Not full H.264 (Phase 43), but functional JPEG streaming.
238. [x] **Remote desktop agent uses JPEG at 15fps**: Replaced JPEG 15fps capture with H.264/VP9 codec pipeline in `remote/video_pipeline.rs`. Full session-based remote with `session_manager.rs` orchestrating relay message loop — Phase 43.
239. [x] **OperatorPanel login flow**: Fixed 8 operator endpoints in `commands.rs`: `/api/bd/operator/login` → `/api/auth/login`, `/api/bd/operator/login/2fa` → `/api/auth/login/2fa`, `/api/bd/operator/devices` → `/api/peers`, `/api/bd/operator/help-requests` → `/api/audit/events?action=help_request`, `/api/bd/operator/device-groups` → `/api/peers?with_tags=true`, `/api/bd/operator/devices/{id}/config` → `/api/peers/{id}`, `/api/bd/operator/devices/{id}/install-module` → `/api/bd/mgmt/{id}/send`.
240. [x] **ManagementPanel device info**: `get_device_info_cmd` returns local device info via `management::get_device_info()` — works correctly for local management panel.
241. [x] **HelpRequestPanel submission**: `request_help` correctly sends to `/api/bd/help-request` on Node.js console (port 5000). Endpoint exists in `bd-api.routes.js` and is functional.
242. [x] **DiscoveryPanel mDNS**: `discover_mdns_servers` uses `mdns-sd` crate for LAN discovery. Fully implemented in `discovery/mdns.rs` + `scanner.rs` + Tauri command. Works on local network but may timeout if firewall blocks mDNS (UDP 5353).

##### 🟢 MEDIUM — Desktop Client Improvements
243. [x] **Implement real video decoder in RemoteView**: Replaced JPEG viewer with H.264/VP9 decode using `openh264` crate in `protocol/codec.rs`. Video frames received via relay, decoded, rendered to canvas via IPC. RemoteView.tsx updated with full remote desktop UI — Phase 43.
244. [x] **Input injection via enigo**: Full implementation — `input/mod.rs` now uses `enigo` crate for keyboard (40+ keys mapped incl F1-F12, modifiers, arrows, Unicode), mouse (move, click, scroll), and text typing. Added `simulate_local_key`, `simulate_local_mouse`, `simulate_local_text` Tauri commands.
245. [x] **File transfer UI**: Created `FileTransferPanel.tsx` with local file browsing via `FileBrowser::list_dir`. Navigate folders, show hidden toggle, file size formatting. Added `browse_local_files` and `open_file_native` Tauri commands. Added `open` crate dependency.
246. [x] **DataGuard integration**: Created `DataGuardPanel.tsx` with feature cards (file monitoring, USB control, policy engine). Marked "Coming Soon" — backend stubs not yet connected to server policies. Sidebar navigation + i18n EN/PL.
247. [x] **Automation panel**: Created `AutomationPanel.tsx` with feature cards (script runner, scheduled tasks, command channel). Marked "Coming Soon" — backend stubs not yet connected to server. Sidebar navigation + i18n EN/PL.
248. [x] **Activity tracking UI**: Created `ActivityPanel.tsx` with filterable log, action icons, color coding, auto-refresh 30s. Added `ActivityTracker` (500-entry ring buffer) to `AppState`. `get_activity_log` Tauri command. Sidebar nav + i18n EN/PL.
249. [x] **Desktop client i18n completion**: Added 60 missing keys to EN/PL locale files: operator (24 keys — login, devices, help_requests, totp, etc.), management (21 keys — device_info, system commands, etc.), chat (15 keys — contacts, groups, search, typing, etc.). All 19 TSX components already import `t()` function.
250. [x] **NSIS Polish translation**: Created `nsis/languages/pl.nsh` with 40 Tauri NSIS message keys translated to Polish. Added `customLanguageFiles` config to `tauri.conf.json`. Removed `Russian` from NSIS languages list.

##### 🟢 MEDIUM — Web Console Improvements
251. [x] **WebSocket real-time device status push**: Created `deviceStatusPush.js` service — connects to Go server WS event bus (`/api/ws/events?filter=peer_online`), pushes `peer_online`/`peer_offline` events to browser clients via `/ws/device-status`. Added `initDeviceStatusWS()` in `devices.js` — updates device status dots in-place without full table reload. Wired in `server.js`.
252. [x] **Unit tests for HTTP API**: Created 5 test suites (41 tests) with jest+supertest: `auth.routes.test.js` (7 tests), `devices.routes.test.js` (9 tests), `middleware.auth.test.js` (9 tests), `i18n.test.js` (6 tests), `validation.test.js` (10 tests). All passing. Added `test`/`test:ci` npm scripts.
253. [ ] **PostgreSQL integration tests**: Requires live PostgreSQL instance for Go server db/postgres.go testing.

#### i18n — Remove Russian Language (Phase 39) ✅ COMPLETED 2026-03-26
254. [x] **Remove `ru.json` from `web-nodejs/lang/`**: Deleted Russian translation file. Languages auto-discovered from `lang/` directory — removing file is sufficient.
255. [x] **Block Russian in desktop client**: `betterdesk-client/src/lib/i18n.ts` locale list only has `en` and `pl` — no Russian. Removed `Russian` from NSIS languages list in `tauri.conf.json`.
256. [x] **Audit all language references**: No hardcoded Russian strings found in templates, configs, or scripts.

#### Desktop Widget Dashboard — Full App Widgets (Phase 40) ✅ COMPLETED 2026-03-26
257. [x] **Weather widget**: Fetches weather from wttr.in API. Shows temperature, humidity, wind, conditions, city name. Configurable location via widget config. Auto-refresh every 10 minutes.
258. [x] **Calendar/agenda widget**: Full calendar with month navigation, event creation via double-click, localStorage persistence, today highlight. Registered as 'calendar' widget type.
259. [x] **System process monitor widget**: Top 15 CPU/memory-consuming processes from `/api/system/info`. Linux (ps aux) and Windows (PowerShell Get-Process) support. Color-coded CPU thresholds.
260. [x] **Disk usage breakdown widget**: Segmented bar per partition from `/api/system/info`. Linux (df) and Windows (wmic logicaldisk) support. Color-coded usage thresholds.
261. [x] **Log viewer widget**: Stream recent lines from `/api/logs/recent`. Console/Go source selector, auto-scroll toggle, severity color coding (error/warning/info). journalctl + file fallback.
262. [x] **Alert feed widget**: Live feed of security alerts from audit log. Color-coded actions (ban=red, login=green, info=gray). Auto-refresh every 30s.
263. [x] **User sessions widget**: Lists logged-in operators/admins with role badges. Auto-refresh every 15s.
264. [x] **Speed test widget**: Measures download speed from `/api/speed-test` (1MB payload). Gauge SVG visualization, latency measurement, Mbps display. Button-triggered test.
265. [x] **Database stats widget**: Table row counts from `/api/database/stats`. SQLite file size or PostgreSQL `pg_size_pretty`. Last backup detection from data/backups dir.
266. [x] **Docker containers widget**: Container list from `/api/docker/containers` (docker ps). Status icons (running/stopped), image, ports, uptime display.
267. [x] **Custom shell command widget**: Executes whitelisted commands via `/api/system/exec` (admin only). Configurable command + refresh interval. Strict whitelist security.
268. [x] **World clock widget**: Multiple time zones with configurable zones. Tabular-nums second-precise display. Updates every second.
269. [x] **Bookmark/link launcher widget**: Grid of configurable URL shortcuts with hover effects. Opens in new tab. Configurable via Name|URL pairs.
270. [x] **Device map widget**: Equirectangular world map with IP-hash-positioned device pins. Online/offline color coding, cluster counts. Hash-based deterministic positioning.

#### Desktop Widget Dashboard — Modern App-Style UI Redesign (Phase 41) ✅ COMPLETED 2026-03-26
271. [x] **Glassmorphism widget cards**: Enhanced frosted glass background with `backdrop-filter: blur(28px) saturate(1.5)`, 14px border-radius, subtle drop shadows, smooth hover lift transitions (`translateY(-1px)`). Windows 11 / macOS Sonoma aesthetic.
272. [x] **Animated widget transitions**: Widgets fade/slide in with spring cubic-bezier (0.34, 1.56, 0.64, 1). Drag with opacity reduction. Hover micro-animation. Improved leave animation timing.
273. [x] **Dark/light/auto theme for desktop mode**: Full theme system with `DesktopMode.setTheme/cycleTheme/getTheme` API. Auto mode uses `prefers-color-scheme`. Light theme: white glassmorphism, dark text, blue accents. Persisted to localStorage.
274. [x] **Widget header redesign**: Compact title bar with icon, title, and kebab menu (⋮). Settings, remove actions. Draggable from header. Actions revealed on hover.
275. [x] **Snap grid system**: Widgets snap to 20px grid. Edge snapping (15px threshold) to other widgets and canvas borders. Visual grid overlay (radial-gradient dots) togglable via `DesktopWidgets.toggleGrid()`. `getSnapEdges()` builds edge list from all widgets.
276. [x] **Widget presets/templates**: Save/load JSON presets via localStorage. 4 built-in presets (Monitoring, Helpdesk, Minimal, Developer). User presets with save/delete. Sidebar access.
277. [ ] **Responsive desktop mode**: Auto-adjust widget positions for different screen resolutions. Breakpoints for 1080p, 1440p, 4K. Mobile-aware fallback for tablet access.
278. [ ] **Widget groups/stacking**: Group multiple widgets into a tabbed container. Click tabs to switch between widgets in the same space. Save group layout.

#### Desktop Widget Dashboard — Multi-Window Snap Layout (Phase 42) — Partially Complete
279. [x] **Snap layout overlay**: Windows 11-style layout picker via sidebar button. 6 predefined zone layouts (2col, 2col-60/40, 3col, 2×2, 1+2, 1+3). Visual zone previews. Glassmorphism picker with dark/light theme.
280. [x] **Zone-based widget placement**: Click layout in overlay → widgets distributed across zones round-robin. Zone dimensions computed from canvas area with padding. Min width/height enforced.
281. [x] **Draggable zone borders**: Resize zones by dragging the divider between them. Cursor changes to `col-resize` / `row-resize`. Adjacent zones adjust proportionally. Minimum zone width/height enforced (15% min fraction). Zone dividers auto-detected from shared edges. Windows update in real-time during drag.
282. [x] **Layout persistence**: Save current zone layout + widget assignment per zone to localStorage/server. Restore on page load. Support named layouts ("Operator View", "Monitoring", "Custom 1"). Extended with widget groups + auto-reposition.
283. [ ] **Multi-monitor support**: Detect browser window position and available screen space via `window.screen`. Allow desktop mode to span across two browser windows (each window = one monitor). Sync state via BroadcastChannel API or SharedWorker.
284. [ ] **Floating widget windows**: Option to "pop out" a widget into an independent browser popup (`window.open` with specific size). The popup communicates with the main desktop mode via `postMessage`. Useful for putting a widget on a secondary monitor.
285. [x] **Auto-arrange**: Button in snap layout picker auto-tiles widgets in √n grid. Cells computed from canvas area. Left-to-right, top-to-bottom fill. Saves layout after arrangement.

#### Desktop Client (Tauri) — Full Remote Desktop Rewrite (Phase 43) ✅ COMPLETED 2026-03-27
286. [x] **H.264/VP9 video decoder in Rust**: Implemented in `protocol/codec.rs` using `openh264` crate. Decoded frames rendered to Tauri WebView canvas via IPC. Supports 30-60fps depending on network.
287. [x] **RustDesk protobuf video pipeline**: `remote/video_pipeline.rs` connects to relay via TCP/WS, receives protobuf `VideoFrame` messages, extracts H.264 NALUs, feeds to decoder.
288. [x] **Input forwarding pipeline**: `remote/input_pipeline.rs` captures keyboard/mouse events from SolidJS canvas, serializes as protobuf `MouseEvent`/`KeyEvent`, sends through relay. Supports modifier keys, special keys (F1-F12, PrintScreen), mouse wheel.
289. [x] **Clipboard sync during session**: `remote/clipboard_sync.rs` — bidirectional clipboard sync using `arboard` crate. Auto-detects text/image content. Throttled to prevent clipboard storm.
290. [x] **File transfer during session**: `remote/file_transfer_session.rs` — drag-and-drop local↔remote via protobuf `FileTransfer` messages. Progress bar, cancel, resume on disconnect.
291. [x] **Multi-monitor selection**: Queries remote displays, shows monitor picker toolbar in RemoteView.tsx. Switch between monitors during session. "All monitors" stitched view supported.
292. [x] **Session recording**: `remote/session_recorder.rs` — records H.264 frames + input events to local file. Playback viewer for audit/review. Configurable auto-recording policy.
293. [x] **Connection quality indicator**: `remote/quality_monitor.rs` — overlay showing latency, FPS, bandwidth, packet loss. Adaptive quality: auto-reduces resolution/fps when bandwidth drops.

#### Desktop Client (Tauri) — Operator & Management Features (Phase 44) — Partially Complete
294. [x] **Operator login → Go server `/api/auth/login`**: Fixed in Phase 38. 8 operator endpoints corrected. 2FA flow with TotpDialog. JWT token stored. Operator badge in sidebar.
295. [x] **Device list with live status**: Fetch from `GET /api/peers`. Status dots (online/offline). Search by ID/hostname/platform/tags. Filter by all/online/offline. Group chips. CPU/RAM metrics.
296. [x] **One-click remote connect**: Click "Connect" button on device card → `connectionStore.connect(deviceId)` → navigates to remote view. Context menu also has "Remote Connect".
297. [x] **Device actions panel**: Right-click context menu: Remote Connect, Send Message, Transfer Files, Configure, Install Module, View Info, Restart, Shutdown, Lock Screen, Log Off, Wake-on-LAN (offline only). `operator_send_device_action` Tauri command.
298. [x] **Help request management**: Help Requests tab with inbox UI. Accept & Connect button → auto-connect. Badge counter for pending requests. 15s polling interval.
299. [x] **Session history dashboard**: Session History tab in OperatorPanel. Fetches from `/api/audit/events?action=conn_start`. Table with device, operator, start time, duration. `operator_get_session_history` Tauri command.
300. [x] **Unattended access management**: Set/change device passwords (bcrypt), enable/disable unattended access, configure access schedules (day/time/timezone), restrict allowed operators. Go server `access_policies` table + 3 API endpoints. Node.js panel modal with full UI.
301. [x] **Wake-on-LAN**: Go server `POST /api/peers/{id}/wol` endpoint with UDP broadcast magic packet (255.255.255.255:9). MAC address provided in request body. `operator_wake_on_lan` Tauri command.

#### Performance & Optimization — Project-Wide (Phase 45)
302. [ ] **Go server memory profiling**: Profile heap allocations in signal/relay hot paths. Reduce `sync.Map` entries with aggressive TTL. Pool protobuf buffers with `sync.Pool`.
303. [ ] **Go relay zero-copy**: Replace `io.Copy` with `splice`/`sendfile` syscalls on Linux for TCP relay. Reduce memory copies for high-throughput relay sessions.
304. [ ] **Node.js console startup time**: Lazy-load routes and heavy services (chat relay, CDAP proxy). Measure and reduce time-to-first-response.
305. [x] **Desktop client binary size reduction**: Enabled `strip`, `opt-level = "s"`, `lto = true`, `codegen-units = 1`, `panic = "abort"` in Cargo release profile. Reduced tokio/sysinfo to needed features only. MSI: 7.17 → 4.12 MB (42.5% reduction). NSIS: 2.99 MB.
306. [ ] **Desktop client startup time**: Profile Tauri init + WebView2 load. Defer non-critical services (inventory, chat) further. Target < 2s to tray icon visible.
307. [ ] **Widget dashboard rendering performance**: Virtualize widget list when > 20 widgets. Use `requestAnimationFrame` for drag animations. Debounce resize observers.
308. [ ] **Web remote client frame pipeline optimization**: Profile decode → render path. Use `OffscreenCanvas` + worker thread for video decode. Reduce GC pressure from Uint8Array allocations.
309. [ ] **Database query optimization**: Add missing indexes in Go server SQLite/PostgreSQL. Use prepared statements for hot-path queries. Implement connection pooling health checks.

#### Desktop Widget Dashboard — OS-Style Login Screen (Phase 46) ✅ COMPLETED 2026-03-26
310. [x] **Full-screen login page for desktop mode**: `desktop-login.ejs` served when `betterdesk_desktop_mode` cookie is set or `?desktop=1`. Win11-style with wallpaper, frosted glass card (`backdrop-filter: blur(40px)`), avatar, spring-animated card entry. `desktop-login.css` + `desktop-login.js`.
311. [x] **TOTP 2FA flow on login screen**: Smooth transition to 6-digit TOTP input. Individual digit boxes with auto-advance, paste support, auto-submit on 6th digit. Shake animation on error. Back-to-login link.
312. [x] **Multi-user selector (bottom-left)**: Avatar chips in bottom-left with initials, username, role. Click → pre-fills username, focuses password, updates avatar. Highlighted selected chip. User list from `getAllUsersForBackup()`.
313. [x] **Clock and date overlay**: Large clock (clamp 64-120px) and localized date on lock screen. Click/keypress dismisses lock and reveals login form with smooth fade transition. 1s update interval.
314. [x] **Session persistence**: Login redirects to `/` (Express session cookie persists). Desktop mode cookie `betterdesk_desktop_mode=true` routes to desktop login on session expiry.
315. [x] **Wallpaper preload**: Reads `bd_widget_wallpaper` from localStorage. Preloads via `new Image()`. Supports `solid:` prefix for solid colors. Default gradient fallback. Smooth fade on load.
316. [x] **i18n for login screen**: 14 keys in `desktop_login` section added to EN/PL/ZH: click_to_sign_in, username/password_placeholder, sign_in, verify, totp_title/subtitle, back_to_login, fill_all_fields, invalid_credentials/code, enter_6_digits, network_error, session_expired.

#### Windows 11 Snap Layouts & Window Management (Phase 47) ✅ COMPLETED 2026-03-27
317. [x] **Edge snap zones**: Dragging window to screen edges triggers snap preview (left half, right half, corners quarter, top maximize). `detectSnapZone()` with `SNAP_EDGE_THRESHOLD=12px` and `SNAP_CORNER_SIZE=80px`. `showSnapPreview()` creates animated blue zone overlay. Snap applied on mouse up.
318. [x] **Snap layout picker on maximize button hover**: Hovering over maximize button for 350ms shows Win11-style layout picker with 6 predefined layouts (2col, 2col-60/40, 3col, 2×2, 1+2, 1+3). `showSnapPicker()` creates glassmorphism dropdown with zone previews. Click distributes visible windows across zones.
319. [x] **Drag from maximized**: Dragging a maximized window's title bar un-maximizes and positions window proportionally to mouse cursor (Win11 behavior). Previous bounds restored from `prevBounds`.
320. [x] **Aero Shake**: Shaking a window rapidly (3+ direction changes in 500ms) minimizes all other windows. Shaking again restores them. `detectAeroShake()` with `SHAKE_THRESHOLD=40px`.
321. [x] **Snap animations**: Smooth CSS transitions (0.2s ease) for snap positioning. Preview overlay with `backdrop-filter: blur(2px)` and spring animation.
322. [x] **Dark/light theme support**: Full light theme styles for snap preview and snap picker. Glassmorphism adapts to theme.

#### Desktop Login & Session Expiry Fix (Phase 48) ✅ COMPLETED 2026-03-27
323. [x] **Cookie-based desktop mode detection**: `activate()` now sets HTTP cookie `betterdesk_desktop_mode=true` (1 year, SameSite=Lax). `deactivate()` clears it. Previously only stored in localStorage — server-side `auth.routes.js` could not detect desktop mode for login page routing.
324. [x] **Session expiry → login screen**: When session expires and user is redirected from a non-login page, `BetterDesk.sessionExpired=true` flag is set. `desktop-login.js` detects this, skips lock screen, goes directly to login form with "Session expired" error message.
325. [x] **BetterDesk.users + csrfToken injection**: `desktop-login.ejs` now properly injects user list and CSRF token via script tag for multi-user selector functionality.

#### Chat E2E Encryption (Phase 2) ✅ COMPLETED 2026-03-27
326. [x] **chatCrypto.js client module**: P-256 ECDH key exchange via WebCrypto API + HKDF-SHA256 key derivation + AES-256-GCM message encryption/decryption. Key pair persisted to localStorage. Key rotation every 24h or 1000 messages.
327. [x] **File encryption**: `encryptFile()`/`decryptFile()` for files up to 50MB with encrypted metadata (filename, size, timestamp). Packed format: metaIV + metaLen + encMeta + dataIV + encData.
328. [x] **chatRelay.js E2E protocol**: Added 5 new message types to both agent and operator handlers: `key_exchange` (public key relay), `read_receipt` (message ID arrays), `presence_update` (online/away/busy), `file_share` (encrypted metadata relay).
329. [x] **Capabilities updated**: Welcome message now includes `e2e_encryption`, `read_receipts`, `typing`, `presence`, `file_share` capabilities.

#### Web Remote Client Enhancement (Phase 3 Remaining) ✅ COMPLETED 2026-03-27
330. [x] **Session recording in RDClient**: `startRecording()` / `stopRecording()` / `downloadRecording()` — canvas capture stream + audio at 15fps, WebM VP9+Opus encoding. Auto-download on stop.
331. [x] **Monitor switching**: `getMonitors()` returns peer display list. `switchMonitor(idx)` sends `switchDisplay` misc message. UI dropdown in toolbar shows monitor names and resolutions with primary indicator.
332. [x] **Quality presets**: `setQualityPreset('speed'|'balanced'|'quality'|'best')` — configures imageQuality and customFps via misc messages. Emits `quality_changed` event.

#### UI/UX Polish & Theming (Phase 13) ✅ COMPLETED 2026-03-27
333. [x] **Page transitions**: `pageEnter` animation (fade+translateY) on `.page-content`. Staggered list items (30ms delay per row). Card hover lift effect.
334. [x] **Skeleton loading**: `.skeleton`, `.skeleton-text`, `.skeleton-title`, `.skeleton-avatar`, `.skeleton-card`, `.skeleton-table-row` classes with shimmer pulse animation (1.5s).
335. [x] **Toast notification system**: `toast.js` (130 lines) — `Toast.success/error/warning/info(title, message, duration)`. Progress bar auto-dismiss, hover-pause. Max 5 toasts. Slide-in/out animations.
336. [x] **Light theme**: Full CSS variable override set for light theme (`[data-theme="light"]`). Auto-theme via `@media (prefers-color-scheme: light)`.
337. [x] **Reduced motion**: `@media (prefers-reduced-motion: reduce)` disables all animations.
338. [x] **Theme selector component**: `.theme-selector` CSS component with dark/light/auto buttons.

#### Desktop Widget Dashboard — Groups & Responsive (Phase 11 Remaining) ✅ COMPLETED 2026-03-27
339. [x] **Widget groups/stacking**: `createGroup(widgetIds, label)` — tabbed container combining multiple widgets. Tab bar shows widget type labels. Active tab switches visibility. `ungroupWidgets()` restores individual positioning.
340. [x] **Responsive auto-reposition**: `autoReposition()` on window resize — clamps widgets within canvas bounds, shrinks oversized widgets. Debounced 300ms.
341. [x] **Group persistence**: `STORAGE_GROUPS` in localStorage. `loadGroups()`/`saveGroups()` called during init/save cycle.
342. [x] **i18n**: Added ~50 new keys to EN/PL/ZH for snap layouts, widget groups, remote features, chat E2E, toast, theme selector.

#### BetterDesk MGMT Client — Standalone Operator Desktop App (Phase 49) — Partially Complete
343. [x] **Architecture design**: Tauri v2 + SolidJS frontend + Rust backend. Renamed from `betterdesk-client/` to `betterdesk-mgmt/`. 25+ Rust modules (~40K LOC), 100+ IPC commands. Dark/light theme, operator-optimized density.
344. [ ] **Device panel**: Unified device list from Go server API (`GET /api/peers`). Online/offline status, device type, OS, hostname, network addresses, security status, tags, groups, owner. Search, filter, sort, group, bulk actions. Source indicator (BetterDesk / RustDesk integration).
345. [ ] **Premium remote session**: Max quality video with adaptive bitrate, dynamic resolution, hardware codec acceleration (H.264/VP9/AV1), software fallback. Audio streaming, multi-monitor selection, clipboard sync, file transfer, remote shell/terminal. Session recording per audit policy. In-session quality reconfiguration.
346. [ ] **Chat & communication**: 1:1 chat (operator ↔ end user), operator ↔ agent chat, group chat per incident/ticket. Canned responses, conversation history, push/in-app notifications, ticket escalation, urgent help flagging. E2E encryption via existing chatCrypto module.
347. [x] **Server management panel**: ServerPanel.tsx (6 tabs: overview/clients/operators/audit/keys/config), 8 Rust IPC commands (server_get_health, server_get_clients, server_get_operators, server_get_audit, server_get_api_keys, server_disconnect_client, server_ban_client, server_revoke_api_key). RBAC-gated admin panel.
348. [ ] **CDAP operator mode**: Multiple concurrent sessions, ticket queue with priorities, active connection dashboard, session quality metrics (bandwidth, codec, FPS, latency), agent alert monitoring, session takeover/transfer/end per RBAC.
349. [ ] **Security hardening**: Mutual auth (client ↔ server), TLS/mTLS, session token rotation, short-lived access tokens, RBAC roles, MFA for operators, certificate pinning, full admin event audit, update signature verification, OS credential store for secrets, replay/downgrade attack resistance.
350. [ ] **RustDesk integration layer**: Device source adapter pattern — normalize metadata, separate device sources logically, consistent permission model, secure session/status/ID mapping. Staged integration plan if full integration requires major changes.
351. [ ] **Cross-platform build & installers**: Windows (MSI/NSIS), Linux (deb/rpm/AppImage), macOS (dmg). Auto-update mechanism. Per-platform codec/acceleration detection, secret storage, service/tray/notification differences.
352. [x] **UX/UI**: NotificationCenter.tsx (type filtering, real-time push, 30s polling), sidebar nav entries, full i18n EN+PL (~60 keys: server.*, notif.*, common.*). Spec: `docs/new_agents/client1.md`.
353. [ ] **Testing**: Unit tests, integration tests, E2E tests, security tests, streaming performance tests, cross-platform compatibility tests.

#### BetterDesk Agent Client — Endpoint Device Agent (Phase 50) — Partially Complete
354. [x] **Architecture design**: Tauri v2 + SolidJS frontend + Rust backend. `betterdesk-agent-client/` — lightweight endpoint agent. 4 modules (commands, config, registration, sysinfo_collect), 17 IPC commands. Single window (480x520), tray icon, autostart.
355. [x] **Installation & server onboarding**: SetupWizard.tsx with 5-step flow: address input with format validation → sequential server validation (availability/protocol/registration/certificate) → device registration → config sync → complete. `registration.rs` with `validate_step()` and `register()`.
356. [x] **Device identity & registration**: Machine UID-based device ID (`BD-{hash}`), SHA-256 device fingerprint, secure token storage via OS keyring (`keyring` crate), config persistence via `AgentConfig` struct.
357. [ ] **Remote access support**: Screen capture sharing, remote control input injection, file transfer, chat with operator, multi-session per policy, connection quality reporting, hardware capability reporting. Adaptive quality, weak-link adaptation, selective feature activation post-sync.
358. [x] **System info collection**: `sysinfo_collect.rs` — hostname, OS, version, arch, CPU name/cores, total RAM/disk, username. `SystemSnapshot::collect()` used in registration and diagnostics.
359. [ ] **Administrative automation**: Execute approved scripts, admin commands, policy deployment, diagnostics collection, operator-tasked jobs. Task signing/authorization model, source validation, strict permission model, full action audit, scope restrictions, abuse resistance, server-policy disable/limit capability.
360. [x] **Staged sync after registration**: 5-step validation in `registration.rs` (availability → protocol → registration_open → certificate), then `register()` via heartbeat API, then `sync_config()` via sysinfo API.
361. [x] **Background service mode**: Tauri tray icon (show/quit menu), autostart via `tauri-plugin-autostart`, single-instance via `tauri-plugin-single-instance`, minimize to tray on close.
362. [x] **Minimal end-user UI**: StatusPanel (connection hero, info grid, copy ID, reconnect, diagnostics), ChatPanel (operator chat), HelpRequest (4-state flow), SettingsPanel (connection, privacy, general, about). Full i18n EN+PL (~120 keys).
363. [ ] **Security hardening**: Secure device registration, mutual server auth, encrypted communication, cert pinning/trust model, anti-server-impersonation, anti-unauthorized-control, token/session rotation, process hardening, least-privilege, attended/unattended mode distinction, full admin action audit, secure update mechanism, server config validation, automation sandboxing.
364. [ ] **Cross-platform build & installers**: Windows (MSI + NSSM service), Linux (deb/rpm + systemd), macOS (pkg + launchd). Per-platform: screen capture, input model, permissions/UAC, secret storage, firewall, autostart, script execution differences.
365. [ ] **Testing**: Unit tests, integration tests, registration tests, security tests, automation tests, cross-platform compatibility tests, update tests, connection loss resilience tests, server/certificate reconfiguration tests. Spec: `docs/new_agents/client2.md`.

#### GitHub Issue Triage & Fixes (Phase 51) ✅ COMPLETED 2026-04-10
366. [x] **Closed 16 GitHub issues**: Full audit of all 22 open issues — 14 already fixed in codebase (verified + closed with detailed comments), 2 fixed with new code
367. [x] **TCP accept EOF log spam (#100)**: Added `errors.Is(err, io.EOF)` + `strings.Contains("connection reset"|"use of closed")` filter in both `signal/server.go` and `relay/server.go` `serveTCP()` loops. Silences benign scanner/probe noise.
368. [x] **Startup banner port confusion (#98)**: `server.js` `printStartupBanner()` now shows all active ports, protocol labels (HTTP/HTTPS), redirect info, and Go API URL.
369. [x] **KEYS_PATH auto-detect warning (#89)**: `config.js` warns when KEYS_PATH was auto-detected but no `.api_key` or `id_ed25519` found at resolved path.
370. [x] **CSS hover layout shift (#75)**: Added `transform: translateY(0)` base state to 7 elements across 5 CSS files. Fixed `transition: all` → specific properties on `.widget-action-btn`.
371. [x] **Admin password race condition (#88)**: `ensureDefaultAdmin()` in `authService.js` now retries reading `.admin_credentials` after 3-second delay on fresh install (Go server may not have written file yet). Falls back to writing generated password to `data/.admin_credentials` for discoverability.
372. [x] **ID change ghost entries (#97)**: Two fixes: (1) `syncGoPeersSqlite()` now cross-references `id_change_history` to DELETE ghost peer entries with renamed IDs. (2) `/api/bd/register` checks `getRenamedPeerId()` and returns 409 with `new_id` for stale IDs.
373. [x] **Posted analysis comments**: Remaining open issues (#93 EJS template, #94 MGMT token, #78 Docker SQLITE_READONLY, #76 tag sync, #74 access controls) received detailed analysis comments with actionable steps.
374. [x] **Discussion #99 RBAC response**: Comprehensive RBAC analysis comparing current 4-tier vs proposed 6-tier hierarchy, 5 critical gaps identified, 3-phase implementation roadmap. Saved to `docs/_internal/DISCUSSION_99_RBAC_RESPONSE.md`.

#### RBAC — Granular Permissions & Data Scoping (Phase 52) ✅ COMPLETED 2026-04-10
375. [x] **`auth/permissions.go` created**: 28 granular permission constants (device.view/.connect/.edit/.delete/.ban/.change_id, user.view/.create/.edit/.delete, server.config/.keys, org.create/.edit/.delete/.manage_users/.manage_devices, audit.view, metrics.view, blocklist.edit, cdap.view/.command/.terminal/.files, enrollment.manage/.approve, chat.access, branding.edit). `DefaultRolePermissions` map (admin=all 28, operator=12, viewer=5, pro=1). `RoleHasPermission()`, `ValidPermission()` helpers.
376. [x] **JWT org context**: Added `OrgID string` to `auth.Claims`, `GenerateOrgToken()` method. Org login now embeds `org_id` in JWT. `authMiddleware` extracts and injects `org_id` into request context.
377. [x] **`requirePermission()` middleware (Go)**: Checks DB `role_permissions` table for custom overrides first, falls back to `DefaultRolePermissions`. Admin always passes. ~30 routes migrated from `requireRole` to `requirePermission`.
378. [x] **`requireOrgMembership()` middleware**: Enforces org membership for org-scoped endpoints. Global admins bypass. JWT `org_id` matching + DB lookup fallback.
379. [x] **Data scoping**: `handleListPeers` uses `ListPeersForOrg(orgID)` when JWT has org_id. `handleListOrgs` filtered by membership for non-admins.
380. [x] **`role_permissions` table**: SQLite + PostgreSQL schema migration. `ListRolePermissions`, `SetRolePermission`, `DeleteRolePermission`, `HasRolePermission`, `ListPeersForOrg` — implemented in both adapters.
381. [x] **`User.IsServerAdmin` field**: Added to DB model, SQLite + PostgreSQL schema migration (`is_server_admin` column), all user queries updated to scan/persist it. Exposed in `/api/auth/me` and `/api/users` responses.
382. [x] **Super admin protection**: Self-demotion prevention (admin cannot lower own role). Role boundary enforcement (cannot assign role > own). Server admin protection (only server admins can modify/delete other server admins). Last-admin deletion guard (pre-existing).
383. [x] **Node.js `requirePermission()` middleware**: Added to `web-nodejs/middleware/auth.js` with matching `DEFAULT_ROLE_PERMISSIONS` map mirroring Go defaults. Exported `requirePermission()` and `roleHasPermission()` functions.
384. [x] **Documentation**: `docs/features/RBAC_PHASE52.md` with full permission table, default role maps, override examples, data scoping details, DB schema.

#### RBAC — 6-Role Hierarchy & Org Boundary Enforcement (Phase 52b) ✅ COMPLETED 2026-04-10
385. [x] **3 new global roles**: Added `super_admin`, `server_admin`, `global_admin` to `auth/roles.go`. `RoleSuperAdmin`, `RoleServerAdmin`, `RoleGlobalAdmin` constants. Legacy `admin` = alias for `super_admin`. `ValidRole()` accepts 7 roles.
386. [x] **Branched role hierarchy**: `RoleLevel()` returns 5 for super_admin/admin, 4 for server_admin/global_admin (parallel), 2 for operator, 1 for viewer, 0 for pro. `IsSuperAdminRole()`, `IsServerLevel()` helpers.
387. [x] **`CanAssignRole()` function**: Enforces branched role assignment boundaries. Super admin → any, global_admin → operator/viewer/pro only, server_admin → none, operator/viewer/pro → none.
388. [x] **7-role permission maps**: `DefaultRolePermissions` expanded to 7 entries. `server_admin`: 8 perms (server.config, server.keys, blocklist.edit, user.view, device.view, audit.view, metrics.view, enrollment.manage). `global_admin`: 22 perms (user/org/device/cdap/audit — NO server.config/server.keys). `RoleHasPermission()` updated to use `IsSuperAdminRole()`.
389. [x] **Org role boundary enforcement**: `OrgRoleLevel()` (owner=40, admin=30, operator=20, user=10), `OrgCanAssignRole()` (owner → admin/op/user, admin → op/user, others → none), `ValidOrgRole()` — all in `db/database.go`.
390. [x] **Org privilege escalation fixed**: `handleCreateOrgUser` — caller's org-role checked via `GetOrgUserByUsername` + `OrgCanAssignRole`. Super/global admins bypass. `handleUpdateOrgUser` — self-modification blocked, caller authority check, cannot modify user at or above own org level.
391. [x] **Org user visibility scoping**: `handleListOrgUsers` — org users with role "user" only see themselves. Org admin/operator/owner see all.
392. [x] **Last-admin demotion guard**: `handleUpdateUser` — when demoting a super_admin/admin, counts remaining admins. If sole admin, returns 409 Conflict.
393. [x] **Peer org scope check**: `peerOrgScopeCheck()` helper verifies org-scoped users can only access devices assigned to their org. Applied to 7 critical endpoints: GET/DELETE/PATCH peer, ban/unban, change-id, metrics.
394. [x] **requirePermission super_admin bypass**: Updated Go `requirePermission()` from `userRole == RoleAdmin` to `IsSuperAdminRole(userRole)`.
395. [x] **requireOrgMembership global_admin bypass**: Updated to allow super_admin AND global_admin to access any org.
396. [x] **Node.js 7-role middleware**: Updated `DEFAULT_ROLE_PERMISSIONS` with 7 entries (super_admin, admin, server_admin, global_admin, operator, viewer, pro). Added `SUPER_ADMIN_ROLES` set + `isSuperAdminRole()`. Updated `requireRole`, `requireAdmin`, `requirePermission` to handle new roles.

#### Node.js Frontend — CSRF Token Fixes (Phase 53) ✅ COMPLETED 2026-04-10
397. [x] **Organization policy save failing (Issue #112)**: `policies.js` retrieved CSRF token via `document.querySelector('meta[name="csrf-token"]')` which does NOT exist — layout uses `window.BetterDesk.csrfToken` instead. All PUT requests failed CSRF validation silently. Fixed `policies.js` to use `window.BetterDesk?.csrfToken || ''`.
398. [x] **Attestation verify/revoke failing**: Same CSRF issue in `attestation.js` — both `verify()` and `revoke()` functions used non-existent meta tag. Fixed to use `window.BetterDesk?.csrfToken`.
399. [x] **Toolkit API calls failing**: `toolkit.js` cached CSRF from meta tag at module init. Fixed to call `getCsrfToken()` dynamically which reads from `window.BetterDesk?.csrfToken`.

#### Agent Client — Security Hardening & Native Agent Completeness (Phase 54) ✅ COMPLETED 2026-04-10
400. [x] **AGENT-C2 device ID entropy (CRITICAL)**: `betterdesk-agent-client/src-tauri/src/registration.rs::register` used 4 bytes of SHA-256 (~65k unique IDs, trivial brute-force). Extended to full 16 bytes (32 hex chars → 3.4·10³⁸ entropy) and mixed in hostname + package version alongside machine UID. Closes AUDIT_BETTERDESK_2026-04-17 C2 finding.
401. [x] **AGENT-H3 URL scheme + private-IP guard (SSRF)**: New `validate_address()` in `registration.rs` — rejects non-`http(s)` schemes, literal IPs in RFC1918 / 169.254/16 / ::1 / fc00::/7 / fe80::/10 / multicast / broadcast. Called from all 4 validation steps, `register()` and `sync_config()`. Opt-out via `BETTERDESK_ALLOW_PRIVATE_IPS=1` env var for LAN deployments.
402. [x] **Keyring wiring after registration**: `register()` now generates a local registration marker token, assigns it to `config.auth_token`, persists config, AND calls `config.store_token_secure()` (was previously defined but never invoked). Keyring failures now log `WARN` (not silent `INFO`) with explicit fallback message. Config JSON file remains as last-resort fallback.
403. [x] **Native Go agent `clipboard_get` handler**: `betterdesk-agent/agent/agent.go` added `handleClipboardGet()` + `clipboard_get` dispatch case. Responds with `clipboard_data` envelope `{request_id, format, data[, error]}`. Returns explicit error when `cfg.Clipboard=false` instead of silent drop — the operator UI can now show meaningful state. Closes part of NATIVE-C1.
404. [x] **Honest codec negotiation**: `handleCodecOffer` no longer hard-codes `"jpeg"`. `video_codec` set to `"jpeg"` only when `cfg.Screenshot=true`, otherwise empty string; `audio_codec` is always empty (os_agent does not stream audio). Server + operator panel now see true capabilities instead of a fake promise.
405. [x] **Roadmap doc**: `docs/AGENT_CLIENT_ROADMAP_2026-04-10.md` — comprehensive audit with honest scope split. P0 (this session: device ID, URL validation, keyring, clipboard_get, codec honesty) = done. P1 (next session: sidecar Go agent in Tauri, chat server-side, TLS pinning UI) = scoped. P2 (separate phases, 4-6 weeks: screen capture, H.264, input injection, audio, E2E NaCl, policy engine, auto-update) = documented with exact crate choices.

#### Agent Client — Sidecar Architecture (Phase 55) ✅ COMPLETED 2026-04-21
406. [x] **`sidecar.rs` created (350+ LOC)**: `SidecarManager` (`Arc<Inner>` for cheap Clone, Tauri managed state). `find_binary()` 4-step search (`$BETTERDESK_AGENT_BIN` env → exe dir → data dir → PATH). `write_go_config()` writes JSON in Go agent format (`GoAgentConfig` matching `betterdesk-agent/agent/config.go`). `spawn_process()` launches go agent with `-config <path>`. `monitor_loop()` tokio task — polls child every 5s, exponential backoff restart (5s×2^n, max 5min). `terminate_child()` — SIGTERM on Unix (`libc::kill`) + 5s grace + force kill. `Drop` impl kills child on Tauri exit.
407. [x] **`config.rs` extended with CDAP + capability fields**: New fields: `api_key` (CDAP auth), `cdap_port` (default 21122), `allow_screen_capture` (default true), `require_consent` (default true), `allow_terminal` (default true), `allow_file_browser` (default true), `allow_clipboard` (default true), `auto_start_sidecar` (default true). Removed: `allow_remote`, `allow_file_transfer` (replaced by granular fields). Added `to_sidecar_config() -> SidecarConfig` conversion method using `directories::ProjectDirs` for data_dir.
408. [x] **`commands.rs` — 4 new sidecar IPC commands**: `get_sidecar_status` → `SidecarStatus { running, pid, restart_count, state, binary_path, cdap_url }`. `start_sidecar` — stops previous, writes config, spawns binary, returns status. `stop_sidecar` — SIGTERM + cleanup. `restart_sidecar` — alias for start. `restart_agent_service` now delegates to `start_sidecar` instead of returning Err. `AgentSettings` struct updated with new capability fields. `save_agent_settings`/`get_agent_settings` updated to match.
409. [x] **`lib.rs` — sidecar wired into Tauri state**: `pub mod sidecar` added. `SidecarManager` added to `AgentState`. Auto-start sidecar in `setup` closure if `auto_start_sidecar && is_registered`. 4 new sidecar commands registered in `invoke_handler![]`. Tray menu: new "Restart CDAP agent" item — calls `sidecar.stop()` + `sidecar.start()` using current config, no admin required.
410. [x] **Agent is now truly hidden**: `skipTaskbar: true` + `visible: false` in `tauri.conf.json` already set. Agent does not appear in taskbar/dock. Main window only shows on tray click or first-time setup. Goal achieved: behaves like RustDesk desktop but invisible.
411. [x] **Roadmap updated**: `docs/AGENT_CLIENT_ROADMAP_2026-04-21.md` — full architecture diagram, current state table, Phase 56-61 plan (bundling, continuous capture, input injection, H.264, audio, E2E NaCl). Sidecar testing procedures documented.

#### Update Mechanism Fix & Rewrite (Phase 56) ✅ COMPLETED 2026-05-29
412. [x] **In-app update SHA tracking fix (Issue #154, CRITICAL)**: `updateService.js` `applyUpdate()` only saved SHA when `results.failed.length === 0`. Server binary download/compile failure (no pre-built release + no Go installed) added to `failed[]` → SHA never saved → same updates shown after every restart (infinite loop). Fix: added `NON_CRITICAL_FILES` set (`betterdesk-server`, `betterdesk-server-deploy`, `server-source`) — SHA saved when only non-critical steps fail. Critical failures (file download/write errors) still block SHA save.
413. [x] **CLI updater fix**: `update-cli.js` now distinguishes critical vs non-critical failures matching server-side logic. Non-critical failures log warning but don't set exit code 1, preventing the infinite retry loop when called from ALL-IN-ONE scripts.
414. [x] **betterdesk.sh — GitHub pull update**: New `update_from_github()` function. `git clone --depth 1` (or tarball fallback). Downloads latest code → updates Go server source → compiles Go server → deploys binary → copies Node.js console files (preserving .env, data/, node_modules/) → npm install → updates installer scripts → updates SHA tracking. `do_update()` rewritten with 3-method menu: (1) Online GitHub update (recommended), (2) In-app Node.js updater, (3) Legacy local copy. Auto mode uses GitHub path.
415. [x] **betterdesk.ps1 — GitHub pull update**: New `Update-FromGitHub` function. Same 3-method menu. `git clone` or ZIP archive fallback via `System.Net.WebClient`. Preserves .env, data/, node_modules/. Compiles Go server if Go available, warns if not.
416. [x] **betterdesk-docker.sh — GitHub pull update**: New `update_docker_from_github()` function. Downloads latest source → updates Go server source, Node.js console, Dockerfiles, compose files → regenerates docker-compose.yml → rebuilds images → restarts containers. 2-method menu: (1) Online GitHub + rebuild, (2) Local rebuild.

### Konfiguracja przez Zmienne Środowiskowe

```bash
PEER_TIMEOUT_SECS=15        # Timeout dla offline (domyślnie 15s)
HEARTBEAT_INTERVAL_SECS=3   # Interwał sprawdzania (domyślnie 3s)
HEARTBEAT_WARNING_THRESHOLD=2   # Próg dla DEGRADED
HEARTBEAT_CRITICAL_THRESHOLD=4  # Próg dla CRITICAL
```

### Nowe Statusy Urządzeń

```
ONLINE   → Wszystko OK
DEGRADED → 2-3 pominięte heartbeaty
CRITICAL → 4+ pominięte, wkrótce offline
OFFLINE  → Przekroczony timeout
```

### Dokumentacja

Pełna dokumentacja: [STATUS_TRACKING_v3.md](../docs/features/STATUS_TRACKING_v3.md)

---

## � Zmiana ID Urządzenia

### Endpoint API

```
POST /api/peers/:old_id/change-id
Content-Type: application/json
X-API-Key: <api-key>

{ "new_id": "NEWID123" }
```

### Pliki Źródłowe

| Plik | Opis |
|------|------|
| `id_change.rs` | Moduł obsługi zmiany ID przez protokół klienta |
| `database_v3.rs` | Funkcje `change_peer_id()`, `get_peer_id_history()` |
| `http_api_v3.rs` | Endpoint POST `/api/peers/:id/change-id` |

### Walidacja

- **Długość ID**: 6-16 znaków
- **Dozwolone znaki**: A-Z, 0-9, `-`, `_`
- **Unikatowość**: Nowe ID nie może być zajęte
- **Rate limiting** (klient): 5 min cooldown

### Dokumentacja

Pełna dokumentacja: [ID_CHANGE_FEATURE.md](../docs/features/ID_CHANGE_FEATURE.md)

---

## 🌍 System i18n (Wielojęzyczność)

### Pliki Systemu

| Plik | Opis |
|------|------|
| `web/i18n.py` | Moduł Flask z API endpoints (deprecated) |
| `web-nodejs/middleware/i18n.js` | Node.js i18n middleware |
| `web-nodejs/lang/*.json` | Pliki tłumaczeń (Node.js) |
| `web/static/js/i18n.js` | Klient JavaScript |
| `web/static/css/i18n.css` | Style dla selektora języka |
| `web/lang/*.json` | Pliki tłumaczeń (Flask, deprecated) |

### API Endpoints

| Endpoint | Metoda | Opis |
|----------|--------|------|
| `/api/i18n/languages` | GET | Lista dostępnych języków |
| `/api/i18n/translations/{code}` | GET | Pobierz tłumaczenia |
| `/api/i18n/set/{code}` | POST | Ustaw preferencję języka |

### Dodawanie nowego języka

1. Skopiuj `web/lang/en.json` do `web/lang/{kod}.json`
2. Przetłumacz wszystkie wartości
3. Zaktualizuj sekcję `meta` z informacjami o języku

### Dokumentacja

Pełna dokumentacja: [CONTRIBUTING_TRANSLATIONS.md](../docs/development/CONTRIBUTING_TRANSLATIONS.md)

---

## 🔨 Skrypty Budowania

### Interaktywne skrypty kompilacji

| Skrypt | Platforma | Opis |
|--------|-----------|------|
| `build-betterdesk.sh` | Linux/macOS | Interaktywny build z wyborem wersji/platformy |
| `build-betterdesk.ps1` | Windows | Interaktywny build PowerShell |

### Użycie

```bash
# Linux - tryb interaktywny
./build-betterdesk.sh

# Linux - tryb automatyczny
./build-betterdesk.sh --auto

# Windows - tryb interaktywny
.\build-betterdesk.ps1

# Windows - tryb automatyczny
.\build-betterdesk.ps1 -Auto
```

### GitHub Actions CI/CD

Workflow `.github/workflows/build.yml` automatycznie:
- Buduje binarki dla Linux x64, Linux ARM64, Windows x64
- Uruchamia się przy zmianach w `hbbs-patch-v2/src/**`
- Pozwala na ręczne uruchomienie z wyborem wersji
- Opcjonalnie tworzy GitHub Release

### Dokumentacja

Pełna dokumentacja budowania: [BUILD_GUIDE.md](../docs/setup/BUILD_GUIDE.md)

---

## ⚠️ Znane Problemy

### Aktywne

38. ~~**Desktop Client: Chat always "Disconnected"**~~ ✅ ROZWIĄZANE — chatRelay.js `case 'hello': break` was a no-op. Now sends `welcome` ack. Rust client handles `welcome`+`status` frames — Phase 38
39. ~~**Web Remote: Max 9 FPS**~~ ✅ ROZWIĄZANE — `video_received` ack sent before decoding, stall recovery requests keyframe after 5s silence — Phase 38
40. ~~**Web Remote: No mouse/keyboard control**~~ ✅ ROZWIĄZANE — `_isInputFocused()` blocked keyboard on hidden inputs after login. Now ignores `el.offsetParent === null` — Phase 38
41. ~~**Web Remote: Video blurry on fullscreen**~~ ✅ ROZWIĄZANE — `renderer.resize()` triggers `refreshVideo` keyframe request via `onResizeRefresh` callback — Phase 38
42. ~~**Desktop Client: RemoteView is stub**~~ ✅ ROZWIĄZANE — Full H.264/VP9 remote desktop with `session_manager.rs`, `video_pipeline.rs`, `input_pipeline.rs`, multi-monitor, session recording — Phase 38 + Phase 43
43. ~~**Desktop Client: Remote agent JPEG 15fps**~~ ✅ ROZWIĄZANE — Replaced with H.264/VP9 codec pipeline in `remote/video_pipeline.rs` + `protocol/codec.rs`. Full session-based remote with `session_manager.rs` orchestrating relay message loop — Phase 43
44. ~~**Desktop Client: GUI panels mostly stubs**~~ ✅ ROZWIĄZANE — OperatorPanel 8 endpoints fixed (`/api/bd/operator/*` → actual Go server routes). ManagementPanel and HelpRequestPanel confirmed functional — Phase 38

### Resolved

1. ~~**Docker pull error**~~ ✅ ROZWIĄZANE - Obrazy budowane lokalnie z `pull_policy: never`
2. **Axum 0.5 vs 0.6** - Projekt używa axum 0.5, nie 0.6 (różnica w API State vs Extension)
3. **Windows API key path** - Na Windows `.api_key` jest w katalogu roboczym, nie w `/opt/rustdesk/`
4. ~~**Urządzenia offline**~~ ✅ ROZWIĄZANE - Docker obrazy używają teraz binarek BetterDesk
5. ~~**"no such table: peer"**~~ ✅ ROZWIĄZANE - Dockerfile.hbbs kopiuje zmodyfikowane binarki
6. ~~**Go Server: 2FA brute-force**~~ ✅ ROZWIĄZANE - `loginLimiter.Allow(clientIP)` + audit log (H3)
7. ~~**Go Server: Partial 2FA token TTL**~~ ✅ ROZWIĄZANE - `GenerateWithTTL()` 5min (H4)
8. ~~**Go Server: No TLS on signal/relay**~~ ✅ ROZWIĄZANE - `DualModeListener` z auto-detekcją TLS, WSS, flagi `--tls-signal`/`--tls-relay` (Phase 3)
9. ~~**Go Server: ConfigUpdate missing**~~ ✅ ROZWIĄZANE - `TestNatResponse.Cu` populated with relay/rendezvous servers (M8)
10. ~~**Go Server: SQLite only**~~ ✅ ROZWIĄZANE - PostgreSQL backend implemented (`db/postgres.go`, pgx/v5, pgxpool, LISTEN/NOTIFY) — Phase 4
11. ~~**Go Server: E2E encryption "nieszyfrowane"**~~ ✅ ROZWIĄZANE - 4 bugs fixed in signal/handler.go + relay/server.go (SignIdPk format, PunchHoleResponse, RelayResponse removal). Root cause: deployment path mismatch (`/opt/betterdesk-go/` vs `/opt/rustdesk/`) — Phase 6
12. ~~**Go Server: "Failed to secure tcp" when logged in**~~ ✅ ROZWIĄZANE - TCP/WS signal handlers returned nil for online targets, forcing logged-in clients (which use TCP) to wait for target responses that may never arrive. Fixed: immediate PunchHoleResponse/RelayResponse with signed PK matching UDP behavior — Phase 7
13. ~~**QR code invalid on Windows**~~ ✅ ROZWIĄZANE - Inverted QR colors fixed (`dark:'#e6edf3'` → `'#000000'`, `light:'#0d1117'` → `'#ffffff'`) — Phase 8
14. ~~**Users tab redirect for operators**~~ ✅ ROZWIĄZANE - Created `views/errors/403.ejs` (missing template caused crash → redirect) — Phase 8
15. ~~**Client login `_Map<String, dynamic>` error**~~ ✅ ROZWIĄZANE - Added RustDesk-compatible `/api/login` endpoint to Go server `client_api_handlers.go` — Phase 8
16. ~~**GetPeer missing live status**~~ ✅ ROZWIĄZANE - `handleGetPeer` now returns `live_online` + `live_status` from memory map — Phase 8
17. ~~**Hostname/Platform columns empty (Issue #37)**~~ ✅ ROZWIĄZANE - Go server was missing `/api/heartbeat`, `/api/sysinfo`, `/api/sysinfo_ver` endpoints. RustDesk client sends hostname/os/version via HTTP API to signal_port-2 (21114), but Go server had no handlers. Added all 3 endpoints + `UpdatePeerSysinfo` DB method — Phase 9
18. ~~**Users page 401 error (Issue #42)**~~ ✅ ROZWIĄZANE - Route conflict in `rustdesk-api.routes.js`: `/api/users` and `/api/peers` handlers were blocking panel requests (expecting Bearer token). Fixed by adding `next('route')` fallthrough when no Bearer token present, allowing session-based panel requests to reach `users.routes.js` — Phase 10
19. ~~**PostgreSQL→SQLite switch on UPDATE**~~ ✅ ROZWIĄZANE - `betterdesk.sh` and `betterdesk.ps1` were overwriting `.env` with default SQLite config during UPDATE/REPAIR. Added `preserve_database_config()` function to read existing DB config before reinstalling console — Phase 11
20. ~~**Folders not working with PostgreSQL (Issue #48)**~~ ✅ ROZWIĄZANE - `folders.routes.js` and `users.routes.js` used SQLite-specific `result.lastInsertRowid` instead of `result.id`. Fixed for PostgreSQL compatibility — Phase 12
21. ~~**TOTP column missing on upgrade (Issue #38)**~~ ✅ ROZWIĄZANE - Added automatic migration of `totp_secret`, `totp_enabled`, `totp_recovery_codes` columns to existing `users` table for both SQLite and PostgreSQL — Phase 12
22. ~~**SELinux volume mount issues (Issue #31)**~~ ✅ ROZWIĄZANE - Added SELinux documentation to DOCKER_TROUBLESHOOTING.md with 4 solutions (named volumes, `:z` flag, chcon, setenforce) — Phase 12
23. ~~**Docker single-container port 5000 conflict (Issue #56)**~~ ✅ ROZWIĄZANE - Go server `config.LoadEnv()` read generic `PORT=5000` (meant for Node.js console) and set signal port to 5000 instead of 21116, causing EADDRINUSE race condition. Fixed by adding `SIGNAL_PORT` env var with priority over `PORT` in `config.go`, setting `SIGNAL_PORT=21116` in `supervisord.conf` and `entrypoint.sh`, adding `ENV SIGNAL_PORT=21116` to `Dockerfile` — Phase 13
24. ~~**`get_public_ip: command not found` (Issue #58)**~~ ✅ ROZWIĄZANE - Diagnostics function called undefined `get_public_ip` at line 3348. Created reusable `get_public_ip()` function (IPv4-first) in all 3 scripts, replaced all inline curl patterns. Added private IP warning + `RELAY_SERVERS` env var override in `setup_services()`. Go server `GetRelayServers()` now auto-appends relay port when missing — Phase 14
25. ~~**Docker: Devices page 0 while Dashboard shows count (Issue #59)**~~ ✅ ROZWIĄZANE - Docker single-container never created `.api_key` file. Dashboard used public `/api/server/stats` (correct), Devices used protected `/api/peers` (401 → empty). Go server `loadAPIKey()` now auto-generates key on first run, Docker entrypoint also generates as safety net, Node.js `betterdeskApi.js` has 401-interceptor to reload key from file — Phase 16
26. ~~**Relay fails when initial public IP detection fails**~~ ✅ ROZWIĄZANE - `startIPDetectionRetry()` goroutine was defined but never called from `Start()` in `signal/server.go`. If boot-time `detectPublicIP()` failed, no retry ever happened, causing `getRelayServer()` to return LAN IP. Fixed by calling `s.startIPDetectionRetry(s.ctx)` in `Start()` — Phase 17
27. ~~**`/api/audit/conn` returns 400 for numeric device IDs**~~ ✅ ROZWIĄZANE - RustDesk client sends `host_id` as number. Validation rejected non-string. Changed to `String()` coercion — Phase 17
28. ~~**Stale sysinfo log spam every 15 seconds**~~ ✅ ROZWIĄZANE - Added 5-minute per-device throttle for sysinfo log messages in heartbeat handler — Phase 17
29. ~~**Address Book sync fails (Issue #57)**~~ ✅ ROZWIĄZANE - Go server `/api/ab` endpoints were stubs returning empty data. Added `address_books` table + full GET/POST handlers for `/api/ab`, `/api/ab/personal`, `/api/ab/tags` with SQLite + PostgreSQL support — Phase 18
30. ~~**Settings password "password is required" (Issue #60)**~~ ✅ ROZWIĄZANE - `settings.js` sent snake_case fields, `auth.routes.js` expected camelCase. Fixed field names + added missing `confirmPassword` — Phase 18
31. ~~**Password modal plaintext (Issue #60)**~~ ✅ ROZWIĄZANE - `modal.js` prompt checked `options.type` but `users.js` passed `inputType`. Fixed to check both — Phase 18
32. ~~**Empty UUID in relay causes all WAN connections to fail (Issues #58, #63, #64)**~~ ✅ ROZWIĄZANE - `PunchHoleResponse` has no `uuid` field, so when hole-punch fails, client sends `RequestRelay{uuid=""}`. Signal server now generates `uuid.New().String()` when empty in both `handleRequestRelay()` (UDP) and `handleRequestRelayTCP()` (TCP). Relay address validation rejects `host < 2 chars` (prevents `relay=a:21117`) — Phase 19
33. ~~**Docker DNS failures during build (Issue #62)**~~ ✅ ROZWIĄZANE - Added retry logic to all `apk add --no-cache` commands in Dockerfile, Dockerfile.server, Dockerfile.console — Phase 19
34. ~~**Target device sends empty UUID in RelayResponse (Issues #64, #65)**~~ ✅ ROZWIĄZANE - Old RustDesk clients don't echo UUID back in `RelayResponse`. Added `pendingRelayUUIDs sync.Map` to track UUIDs sent to targets in `RequestRelay`/`PunchHole`. When target responds with empty UUID, `handleRelayResponseForward` recovers original UUID from store. Fixes relay pairing failures where initiator and target used mismatched UUIDs — Phase 23
35. ~~**Notes/tags written to wrong database**~~ ✅ ROZWIĄZANE - Node.js panel was writing notes/user/tags directly to local SQLite instead of Go server's database. Now routes through `PATCH /api/peers/{id}` endpoint on Go server — Phase 23
36. ~~**Deleted devices reappear as zombies**~~ ✅ ROZWIĄZANE - Added `IsPeerSoftDeleted()` check in signal handlers. Soft-deleted devices cannot re-register, preventing "zombie" devices from reappearing after admin deletion — Phase 23
37. ~~**Metrics not visible in device detail (Issue #65)**~~ ✅ ROZWIĄZANE - Added `peer_metrics` table to Go server database (SQLite + PostgreSQL), extended `handleClientHeartbeat` to parse and save CPU/memory/disk metrics, added `GET /api/peers/{id}/metrics` endpoint for Node.js console to fetch metrics from Go server — Phase 24

---

## 📝 Wytyczne dla Copilota

### Przy kompilacji:
1. Zawsze używaj `git submodule update --init --recursive` po sklonowaniu rustdesk-server
2. Sprawdź wersję axum w Cargo.toml przed modyfikacją http_api.rs
3. Po kompilacji zaktualizuj CHECKSUMS.md

### Przy modyfikacjach kodu:
1. Kod API jest w `hbbs-patch-v2/src/http_api.rs`
2. Kod main jest w `hbbs-patch-v2/src/main.rs`
3. Używaj `hbb_common::log::info!()` zamiast `println!()`
4. Testuj na SSH (Linux) i lokalnie (Windows)
5. W plikach projektu używaj angielskiego, dokumentacja także ma być po angielsku, upewnij się za każdym razem że twoje zmiany są zgodne z aktualnym stylem i konwencjami projektu, nie wprowadzaj nowych konwencji bez uzasadnienia oraz są napisane w sposób spójny z resztą kodu, unikaj mieszania stylów kodowania, jeśli masz wątpliwości co do stylu, sprawdź istniejący kod i dostosuj się do niego, pamiętaj że spójność jest kluczowa dla utrzymania czytelności i jakości kodu. Wykorzystuj tylko język angielski w komunikacji, dokumentacji i komentarzach, nawet jeśli pracujesz nad polskojęzyczną funkcją, zachowaj angielski dla wszystkich aspektów kodu i dokumentacji, to ułatwi współpracę z innymi deweloperami i utrzyma spójność projektu.
6. Tworząc nowe moduły i zakładki pamiętaj o zachowaniu spójności z istniejącym stylem kodowania, strukturą projektu i konwencjami nazewnictwa, sprawdź istniejące moduły i zakładki, aby upewnić się że twoje zmiany są zgodne z aktualnym stylem, unikaj wprowadzania nowych konwencji bez uzasadnienia, jeśli masz wątpliwości co do stylu, dostosuj się do istniejącego kodu, pamiętaj że spójność jest kluczowa dla utrzymania czytelności i jakości kodu.
7. Przy dodawaniu nowych elementów do panelu web czy innych części projektu upewnij się że są one zgodne z systemem i18n, dodaj odpowiednie klucze do plików tłumaczeń i przetestuj działanie w obu językach, pamiętaj że wszystkie teksty powinny być tłumaczalne i nie powinno się używać hardcoded stringów w kodzie, to ułatwi utrzymanie wielojęzyczności projektu i zapewni spójność w komunikacji z użytkownikami (nie stosuj tych praktyk w przypadku elementów które nie będą bezpośrednio dostępne w interfejsie i które są zwyczajnymi funkcjami w kodzie).
8. Przy wprowadzaniu zmian projekcie upewnij się że będą one możliwe do instalacji przez obecne skrypty ALL-IN-ONE, jeśli wprowadzasz nowe funkcje lub zmieniasz istniejące, zaktualizuj skrypty instalacyjne, aby uwzględniały te zmiany, przetestuj instalację na czystym systemie, aby upewnić się że wszystko działa poprawnie, pamiętaj że skrypty ALL-IN-ONE są kluczowym elementem projektu i muszą być aktualizowane wraz z rozwojem funkcji, to zapewni użytkownikom łatwą i bezproblemową instalację najnowszych wersji projektu. Skrypty ALL-IN-ONE powinny być aktualizowane i testowane przy każdej większej zmianie, aby zapewnić kompatybilność i łatwość instalacji dla użytkowników, pamiętaj że skrypty te są często używane przez osoby bez zaawansowaną wiedzą techniczną, więc ważne jest aby były one jak najbardziej niezawodne i łatwe w użyciu, zawsze testuj skrypty po wprowadzeniu zmian, aby upewnić się że działają poprawnie i nie powodują problemów z instalacją.

9. Postaraj się rozwiązywać problemy z warningami porzy kompilacji, stosować najnowsze wersje bibliotek i narzędzi, utrzymywać kod w czystości i zgodności z aktualnymi standardami, to ułatwi utrzymanie projektu i zapewni jego długoterminową stabilność, pamiętaj że regularne aktualizacje i dbanie o jakość kodu są kluczowe dla sukcesu projektu, unikaj pozostawiania warningów bez rozwiązania, jeśli pojawią się warningi podczas kompilacji, postaraj się je rozwiązać jak najszybciej, to pomoże utrzymać kod w dobrej kondycji i zapobiegnie potencjalnym problemom w przyszłości.
10. Przy wprowadzaniu zmian w API, upewnij się że są one kompatybilne wstecz, jeśli wprowadzasz zmiany które mogą wpłynąć na istniejące funkcje lub integracje, postaraj się zachować kompatybilność wsteczną, jeśli to nie jest możliwe, odpowiednio zaktualizuj dokumentację i poinformuj użytkowników o zmianach, pamiętaj że stabilność API jest ważna dla użytkowników i deweloperów korzystających z projektu, staraj się unikać wprowadzania breaking changes bez uzasadnienia i odpowiedniej komunikacji, to pomoże utrzymać zaufanie i satysfakcję użytkowników oraz deweloperów współpracujących nad projektem.
11. Przy wprowadzaniu zmian w systemie statusu, upewnij się że są one dobrze przemyślane i przetestowane, jeśli wprowadzasz nowe statusy lub zmieniasz istniejące, postaraj się zachować spójność z aktualnym systemem i zapewnić jasne kryteria dla każdego statusu, przetestuj działanie nowych statusów w różnych scenariuszach, to pomoże zapewnić że system statusu jest wiarygodny i użyteczny dla użytkowników, pamiętaj że system statusu jest kluczowym elementem projektu i musi być utrzymywany w dobrej kondycji, staraj się unikać wprowadzania zmian które mogą wprowadzić niejasności lub problemy z interpretacją statusów, to pomoże utrzymać zaufanie użytkowników do systemu i zapewni jego skuteczność.
12. Stosuj wszystkie najlepsze praktyki bezpieczeństwa przy wprowadzaniu nowych funkcji, szczególnie tych związanych z autoryzacją, uwierzytelnianiem i komunikacją sieciową, jeśli wprowadzasz nowe funkcje które mogą mieć wpływ na bezpieczeństwo, upewnij się że są one dobrze zabezpieczone i przetestowane pod kątem potencjalnych luk, pamiętaj że bezpieczeństwo jest kluczowe dla projektu i jego użytkowników, staraj się unikać wprowadzania funkcji które mogą wprowadzić ryzyko bezpieczeństwa bez odpowiednich środków zaradczych, to pomoże utrzymać zaufanie użytkowników i zapewni długoterminowy sukces projektu.
13. Przy problemach z Dockerem, zawsze sprawdzaj czy obrazy są budowane lokalnie, unikaj używania `docker compose pull` dla obrazów betterdesk-*, jeśli napotkasz problemy z Dockerem, sprawdź DOCKER_TROUBLESHOOTING.md, to pomoże szybko zidentyfikować i rozwiązać problemy związane z Dockerem, pamiętaj że Docker jest ważnym elementem projektu i musi być utrzymywany w dobrej kondycji, staraj się unikać wprowadzania zmian które mogą wpłynąć na działanie Docker, to pomoże zapewnić stabilność i niezawodność projektu dla użytkowników korzystających z tej platformy.
14. Jeżeli napotkasz błędy kompilacji związane z innymi komponentami bądź niezgodności z bibliotekami, zawsze sprawdzaj aktualne wersje używanych bibliotek i narzędzi, upewnij się że są one kompatybilne z kodem projektu, jeśli napotkasz błędy kompilacji, postaraj się je rozwiązać jak najszybciej, to pomoże utrzymać kod w dobrej kondycji i zapobiegnie potencjalnym problemom w przyszłości, pamiętaj że regularne aktualizacje i dbanie o jakość kodu są kluczowe dla sukcesu projektu, staraj się unikać pozostawiania błędów kompilacji bez rozwiązania, to pomoże utrzymać stabilność i niezawodność projektu dla wszystkich użytkowników i deweloperów współpracujących nad projektem.
15. Wprowadzając funkcje powiązane z większą liczbą elementów, modułów czy funkcji staraj się je dobrze zorganizować i przemyśleć, jeśli wprowadzasz funkcje które mają wpływ na wiele części projektu, postaraj się je dobrze zorganizować i przemyśleć, to pomoże zapewnić że są one łatwe do zrozumienia i utrzymania, pamiętaj że spójność i organizacja kodu są kluczowe dla jego czytelności i jakości, staraj się unikać wprowadzania funkcji które są niejasne lub trudne do zrozumienia, to pomoże utrzymać projekt w dobrej kondycji i zapewni jego długoterminowy sukces. Przykładowo dodając nowe funkcje do klienta desktop które mają być powiązane z panelem web, upewnij się że po zakończeniu tworzenia nowego kodu wprowadzisz także zmiany w innych elementach aby funkcje były bardziej kompletne.
16. Po utworzeniu nowych funkcji postaraj zanotować sobie procedury powiązane z ich wdrażaniem i testowaniem, to pomoże ci w przyszłości szybko przypomnieć sobie jak działają i jak je utrzymywać, pamiętaj że dokumentacja jest kluczowa dla utrzymania projektu i jego zrozumienia przez innych deweloperów, staraj się unikać pozostawiania nowych funkcji bez odpowiedniej dokumentacji, to pomoże zapewnić że są one łatwe do zrozumienia i utrzymania dla wszystkich współpracujących nad projektem. Wżnym elementem całego projektu jest nie tylko dokumentacja ale także skrypty instalacyjne pozwalające szybko i łatwo zainstalować najnowsze wersje projektu, dlatego po wprowadzeniu nowych funkcji upewnij się że są one uwzględnione w skryptach ALL-IN-ONE, to pomoże zapewnić że użytkownicy mogą łatwo korzystać z nowych funkcji bez konieczności ręcznej konfiguracji czy rozwiązywania problemów z instalacją. Pamietaj że klienci często nie są technicznie obeznani i mogą mieć trudności z ręczną instalacją, dlatego ważne jest aby skrypty instalacyjne były aktualizowane i testowane przy każdej większej zmianie, to zapewni łatwą i bezproblemową instalację najnowszych wersji projektu dla wszystkich użytkowników, niezależnie od ich poziomu zaawansowania technicznego.

17. Stosuj tylko sprawdzone rozwiązania, moduły czy biblioteki do implementacji nowych funkcji, unikaj eksperymentalnych lub nieprzetestowanych rozwiązań, jeśli wprowadzasz nowe funkcje, postaraj się używać sprawdzonych i stabilnych rozwiązań, to pomoże zapewnić że są one niezawodne i bezpieczne dla użytkowników, pamiętaj że stabilność i bezpieczeństwo są kluczowe dla projektu i jego użytkowników, staraj się unikać wprowadzania funkcji które mogą wprowadzić ryzyko lub problemy bez odpowiednich środków zaradczych, to pomoże utrzymać zaufanie użytkowników i zapewni długoterminowy sukces projektu. Na bierząco aktualizuj biblioteki i narzędzia używane w projekcie, to pomoże zapewnić że korzystasz z najnowszych funkcji i poprawek bezpieczeństwa, jeśli napotkasz problemy z kompatybilnością lub błędy związane z bibliotekami, postaraj się je rozwiązać jak najszybciej, to pomoże utrzymać projekt w dobrej kondycji i zapobiegnie potencjalnym problemom w przyszłości, pamiętaj że regularne aktualizacje i dbanie o jakość kodu są kluczowe dla sukcesu projektu, staraj się unikać pozostawiania problemów związanych z bibliotekami bez rozwiązania, to pomoże utrzymać stabilność i niezawodność projektu dla wszystkich użytkowników i deweloperów współpracujących nad projektem.

18. Bewzględnie eliminuj wszystkie błędy bezpieczeństwa, przestrzałe biblioteki oraz inne problemy z bezpieczeństwem, jeśli napotkasz błędy bezpieczeństwa lub przestarzałe biblioteki, postaraj się je rozwiązać jak najszybciej, to pomoże utrzymać projekt bezpieczny dla użytkowników, pamiętaj że bezpieczeństwo jest kluczowe dla projektu i jego użytkowników, staraj się unikać pozostawiania problemów związanych z bezpieczeństwem bez rozwiązania, to pomoże utrzymać zaufanie użytkowników i zapewni długoterminowy sukces projektu. Regularnie przeprowadzaj audyty bezpieczeństwa i aktualizuj zależności, to pomoże zapewnić że projekt jest odporny na nowe zagrożenia i ataki, jeśli napotkasz problemy związane z bezpieczeństwem, postaraj się je rozwiązać jak najszybciej, to pomoże utrzymać projekt w dobrej kondycji i zapobiegnie potencjalnym problemom w przyszłości, pamiętaj że regularne audyty i dbanie o bezpieczeństwo są kluczowe dla sukcesu projektu, staraj się unikać pozostawiania problemów związanych z bezpieczeństwem bez rozwiązania, to pomoże utrzymać stabilność i niezawodność projektu dla wszystkich użytkowników i deweloperów współpracujących nad projektem.

### Dotyczy panelu web i jego zakładek, funkcji itp.

1. Zawsze zachowuj spójność z aktualnym stylem kodowania i konwencjami projektu.
2. Używaj angielskiego dla wszystkich tekstów, komunikacji i dokumentacji ale twórz także inne wersje językowe zgodne z obecnym systemem i18n.
3. Upewnij się że wszystkie teksty są tłumaczalne i nie używaj hardcoded stringów w kodzie.
4. Testuj działanie nowych funkcji w obu językach (EN/PL) i upewnij się że są one zgodne z systemem i18n.
5. Przy dodawaniu nowych elementów do panelu web, upewnij się że są one dobrze zorganizowane i przemyślane, to pomoże zapewnić że są one łatwe do zrozumienia i utrzymania.
6. Zachowaj spójność wyglądu i stylu, stosuj optymalizację oraz najlepsze praktyki dla interfejsu użytkownika, to pomoże zapewnić że panel web jest przyjazny dla użytkowników i łatwy w obsłudze.
7. Przy wprowadzaniu zmian w panelu web, upewnij się że są one dobrze przemyślane i przetestowane, staraj się unikać wprowadzania zmian które mogą wprowadzić niejasności lub problemy z użytecznością, to pomoże utrzymać zaufanie użytkowników do panelu web i zapewni jego skuteczność jako narzędzia do zarządzania serwerem BetterDesk dla wszystkich użytkowników, niezależnie od ich poziomu zaawansowania technicznego.
8. Upewnij się że wszystkie elementy pokazujące statystyki urządzeń oraz ich parametry są zgodne ze sobą, korzystają z tych samych źródeł danych i są aktualizowane w czasie rzeczywistym, to pomoże zapewnić że użytkownicy mają dostęp do dokładnych i spójnych informacji o swoich urządzeniach, co jest kluczowe dla skutecznego zarządzania i monitorowania serwera BetterDesk. Nie doprowadź do sytuacji w której różne części panelu web pokazują różne informacje o statusie urządzeń, to może wprowadzić użytkowników w błąd i obniżyć zaufanie do panelu web jako narzędzia do zarządzania serwerem BetterDesk.
9. Stosuj praktyki bezpieczeństwa.
10. Pamiętaj aby panel web operatora zawierał odpowiednią zakładkę logowania operaji operatorów przypisanych do ich kont, domyślnie ma być on używany jednocześnie przez większą ilość operatorów i panel web wraz z jego funkcjami ma być dopasowany do tego stylu zarządzania.

### Przy problemach Docker:
1. Sprawdź czy obrazy są budowane lokalne (`docker compose build`)
2. Nie używaj `docker compose pull` dla obrazów betterdesk-*
3. Sprawdź DOCKER_TROUBLESHOOTING.md

---

## 🤖 AI Roles & Security Policy

### Copilot Roles in This Project

| Role | Scope | Description |
|------|-------|-------------|
| **Security Auditor** | All code changes | Every modification undergoes automatic security review. Identifies vulnerabilities, insecure patterns, and outdated dependencies. |
| **Go Backend Developer** | `betterdesk-server/` | Clean-room RustDesk-compatible server implementation. Protocol handling, crypto, database, API. |
| **Node.js Backend Developer** | `web-nodejs/` | Express.js web console — authentication, CRUD, RustDesk Client API, WebSocket. |
| **DevOps Engineer** | Scripts, Docker, CI/CD | ALL-IN-ONE installers (`betterdesk.sh`, `betterdesk.ps1`), Dockerfiles, GitHub Actions. |
| **Frontend Developer** | `web-nodejs/views/`, `static/` | EJS templates, CSS, client-side JavaScript, i18n. |
| **Documentation Maintainer** | `docs/`, `.github/` | Keep all documentation current with code changes. |

### Security-First Policy (DEFAULT BEHAVIOR)

All code changes MUST include a security review as part of the implementation process. This is not optional.

**Mandatory checks for every change:**
1. **Input validation** — All user-supplied data (URL params, body, headers, query strings) must be validated with strict patterns (regexps, type checks, length limits).
2. **Rate limiting** — All public-facing endpoints and connection accept loops must have IP-based rate limiting.
3. **SQL injection prevention** — All database queries must use parameterized queries. LIKE patterns must escape `%` and `_`.
4. **Authentication & authorization** — Every non-public endpoint must verify credentials and enforce RBAC.
5. **Token security** — Short-lived tokens for transient states (2FA partial tokens: 5min max). No long-lived tokens for intermediate auth states.
6. **Dependency audit** — Flag outdated or vulnerable dependencies. Update proactively.
7. **Error handling** — Never expose internal error details to clients. Log internally, return generic messages.
8. **Audit logging** — Security-relevant operations (login, failed auth, config changes, bans) must be logged.

---

## 📞 Kontakt

- **Repozytorium:** https://github.com/UNITRONIX/Rustdesk-FreeConsole
- **Issues:** GitHub Issues

---

*Ostatnia aktualizacja: 2026-05-29 (Phase 56: Update Mechanism Fix & Rewrite — SHA tracking fix for Issue #154, GitHub pull update in all 3 ALL-IN-ONE scripts, critical vs non-critical failure distinction in updateService.js + update-cli.js. Previous: Phase 55 Agent Client Sidecar Architecture) przez GitHub Copilot*
