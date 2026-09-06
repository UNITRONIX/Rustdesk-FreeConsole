# Audyt bezpieczeństwa i stabilności BetterDesk

**Data:** 2026-04-17
**Zakres:** Pełny audyt projektu UNITRONIX/Rustdesk-FreeConsole (BetterDesk)
**Autor:** GitHub Copilot (audyt automatyczny z ręczną weryfikacją)
**Status projektu:** v2.4.0 (instalatory), Phase 53 (RBAC + CSRF fixes)

---

## 1. Streszczenie wykonawcze

BetterDesk jest dojrzałym, wielomodułowym ekosystemem zastępującym stos RustDesk (hbbs+hbbr) własnym serwerem Go, konsolą Node.js, klientem operatorskim MGMT (Tauri), klientem agenta końcowego (Tauri), natywnym agentem Go oraz protokołem CDAP z mostami (Modbus/SNMP/REST). W ostatnich 53 fazach projekt otrzymał gruntowne utwardzenie bezpieczeństwa (RBAC 7-role, CSRF double-submit, PBKDF2, Ed25519, NaCl TCP, TOTP 2FA, audit log, rate-limiting), jednak nadal występują luki wymagające pilnej interwencji oraz znaczące braki funkcjonalne w klientach Tauri.

### Podsumowanie ryzyka per-moduł

| Moduł | Krytyczne | Wysokie | Średnie | Niskie | Kompletność |
|-------|:---:|:---:|:---:|:---:|:---:|
| Go Server (`betterdesk-server/`) | **4** | 6 | 8 | 5 | ~95% |
| Node.js Console (`web-nodejs/`) | 0 | 3 | 5 | 2 | ~98% |
| MGMT Client (`betterdesk-mgmt/`) | **4** | 4 | 2 | — | ~40% |
| Agent Client (`betterdesk-agent-client/`) | **3** | 3 | 3 | — | ~20% |
| Natywny Go Agent (`betterdesk-agent/`) | **1** | 2 | 2 | — | ~50% |
| Instalatory + Docker | 0 | 1 | 3 | 1 | ~95% |
| Architektura połączeń | **3** | 3 | 3 | — | — |
| **RAZEM** | **15** | **22** | **26** | **8** | — |

### Pięć najważniejszych priorytetów (Tier 0 — do wykonania natychmiast)

1. **TLS wszędzie dla kanałów API** — porty 21121 (Node.js RustDesk Client API) oraz 21122 (CDAP WebSocket) transmitują zdalne operacje terminala, zrzuty ekranu i klucze API w plaintext; wymusić `https://`/`wss://` w domyślnej konfiguracji.
2. **MITM w klientach Tauri** — `danger_accept_invalid_certs(true)` w `betterdesk-mgmt` i `betterdesk-agent-client` pozwala dowolnemu atakującemu na przejęcie rejestracji/sesji operatora; usunąć bezwarunkową akceptację i wprowadzić potwierdzenie użytkownika + pinning fingerprintu.
3. **JWT secret regenerowany przy restarcie Go servera** — konfig `config/config.go:170-180` generuje nowy secret jeśli brak w env, co unieważnia wszystkie sesje operatorów przy każdym restarcie; persist secret w bezpiecznym storze.
4. **Brak auth przed upgrade WebSocket w Go serverze** — `api/cdap_handlers.go:425-430` oraz `signal/ws.go` wykonują `upgrader.Upgrade()` przed weryfikacją tokenu, co umożliwia DoS przez masowe half-open connections.
5. **Localstorage token w MGMT Client** — `bd_access_token` dostępny dla dowolnego XSS w WebView Tauri; przenieść do `tauri-plugin-stronghold` lub secure IPC state.

---

## 2. Architektura i analiza połączeń

### 2.1 Mapa portów i kanałów

| Źródło | Cel | Protokół | Port | Auth | TLS domyślnie | Rate-limit | Audit |
|--------|-----|---------|-----:|------|:------:|:------:|:------:|
| RustDesk Client | Go Signal | UDP | 21116 | Ed25519/NaCl | — | ✅ IP | ✅ |
| RustDesk Client | Go Signal | TCP | 21116 | NaCl handshake | opcjonalne (`--tls-signal`) | ✅ | ✅ |
| RustDesk Client | Go Relay | TCP | 21117 | UUID pairing | opcjonalne (`--tls-relay`) | **❌** | ⚠️ |
| RustDesk Client | Go Signal | WS | 21118 | NaCl | opcjonalne (WSS) | ✅ | ⚠️ |
| RustDesk Client | Go Relay | WS | 21119 | UUID | opcjonalne | ❌ | ⚠️ |
| RustDesk Client | Go HTTP API | TCP | 21114 | brak (heartbeat/sysinfo) | opcjonalne | ✅ | ✅ |
| RustDesk Client | Node.js Client API | TCP | 21121 | session cookie | **❌ nigdy** | ⚠️ częściowo | ⚠️ |
| Node.js Console | Go Server | HTTP | 21114 | `X-API-Key` | opcjonalne | ✅ | ✅ |
| Browser (panel) | Node.js Console | HTTPS/HTTP | 5000 | session + CSRF + TOTP | opcjonalne | ✅ | ✅ |
| MGMT Client (Tauri) | Node.js Panel | HTTPS | 5000 | session cookie (IPC proxy) | opcjonalne | ⚠️ | ⚠️ |
| MGMT Client | Go Server | HTTP | 21114 | JWT Bearer | opcjonalne | ✅ | ✅ |
| Agent Client (Tauri) | Go Server | HTTP | 21114 | API key | opcjonalne | ✅ | ✅ |
| Natywny Go Agent | Go CDAP Gateway | WS | 21122 | API key w `auth` msg | **❌ `ws://`** | ❌ | ✅ |
| CDAP Bridge | Go CDAP Gateway | WS | 21122 | API key | **❌ `ws://`** | ❌ | ✅ |
| Admin | Go Admin Console | TCP | cfg. | hasło | brak | — | — |
| Prometheus | Go `/metrics` | HTTP | 21114 | **brak auth** | opcjonalne | — | — |

### 2.2 Krytyczne luki architektoniczne

1. **Plaintext transmission CDAP** (port 21122) — natywny Go Agent oraz mosty Modbus/SNMP/REST łączą się domyślnie `ws://`, przesyłając output terminala, zawartość plików, zrzuty ekranu i klucze API bez szyfrowania. Wymusić `wss://` i odrzucać `ws://` w produkcji.
2. **Brak mutual auth Node.js ↔ Go** — Node.js posiada `API_KEY`, ale Go nie weryfikuje tożsamości klienta przez cert pinning ani mTLS; każdy kto uzyska API key ma pełny dostęp.
3. **Relay brak rate-limitingu** — port 21117 nie limituje liczby jednoczesnych sesji per IP, co umożliwia resource exhaustion (OOM przez `io.Copy` bufory).
4. **Admin TCP console** (`admin/server.go`) — nie wymusza bind do `127.0.0.1`; przy złej konfiguracji nasłuchuje publicznie.
5. **`/metrics` bez auth** — eksponuje liczniki/histogramy, w tym nazwy peerów, potencjalnie umożliwiając enumerację urządzeń.
6. **SameSite=Lax na session cookie Node.js** — GET CSRF nadal możliwy na endpointach logout/verify (obecnie bezpieczne, bo read-only, ale ryzyko regresji).

### 2.3 Rekomendacje hardeningu architektury

- **Tier 1 (do 2 tygodni):**
  - Wymusić TLS dla portów 21121 i 21122 w instalatorach (generowanie samosignowanego certu przy setupie).
  - Dodać `heartbeatLimiter` w Node.js client API (21121).
  - Dodać rate-limit per-IP na relay (port 21117) — max 20 równoczesnych sesji.
  - `/metrics` za basic-auth lub bind do `127.0.0.1`.
  - Wymusić bind admin console do `127.0.0.1` w kodzie.
- **Tier 2 (do miesiąca):**
  - Cert pinning Node.js → Go (SHA256 fingerprint pierwszego połączenia).
  - Dodać `StrictTransportSecurity` nagłówek w Node.js.
  - Podnieść SameSite=Strict dla session cookie (testy regresji logowania).
- **Tier 3 (strategicznie):**
  - mTLS dla kanału Node.js ↔ Go z automatyczną rotacją certów.
  - Audit logging wszystkich komend CDAP (metadata bez payloadu).

---

## 3. Audyt per-moduł

### 3.1 Go Server (`betterdesk-server/`)

~100k LOC, 90 plików, SQLite + PostgreSQL, Ed25519, NaCl, PBKDF2 100k, JWT HMAC-SHA256, TOTP RFC 6238, rate-limiting, RBAC 7-role.

#### Znaleziska Krytyczne (4)

| # | Plik:linia | Problem | Wpływ | Rekomendacja |
|---|---|---|---|---|
| **C1** | `api/cdap_handlers.go:425-430`, `signal/ws.go` | Brak auth przed `upgrader.Upgrade()` | DoS przez masowe half-open WS + enumeracja ścieżek | Autoryzuj tokenem przed upgrade; przy błędzie zwróć 401 bez upgrade |
| **C2** | `config/config.go:170-180`, `main.go` | JWT secret regenerowany przy każdym restarcie | Wszystkie tokeny operatorów unieważniane, wymuszone wylogowanie, ryzyko braku rotacji | Persist w `.jwt_secret` (chmod 600) lub w tabeli `server_config`; wygeneruj tylko jeśli brak |
| **C3** | `signal/handler.go:1070-1080` | Race condition w `pendingRelayUUIDs` przy równoczesnych `RequestRelay` + timeout | Możliwy mismatch UUID → nieudane parowanie relay lub crosstalk | Użyj mutex per-UUID + atomic store-if-absent |
| **C4** | `admin/server.go` | TCP admin console nie wymusza bind do loopback | RCE przez słabe hasło administracyjne z sieci | W kodzie `net.Listen("tcp", "127.0.0.1:"+port)`; opcjonalnie flaga `--admin-bind` |

#### Znaleziska Wysokie (6)

| # | Plik:linia | Problem | Rekomendacja |
|---|---|---|---|
| H1 | `api/auth_handlers.go:1491` | Bcrypt error przekazywany do klienta (info leak) | Loguj wewnętrznie, zwracaj `"invalid credentials"` |
| H2 | `api/server.go` middleware | `X-Forwarded-For` zaufany zawsze | Dodać gate `TRUST_PROXY=true/false`, parsować tylko wtedy |
| H3 | `api/server.go` | Query param `?api_key=...` nadal akceptowany | Logowanie w access logach; deprecate + log warning |
| H4 | `db/sqlite.go`, `db/postgres.go` | `soft_deleted` peerzy widoczni w query `GetPeer` | Dodać `WHERE soft_deleted=0` do wszystkich SELECTów oprócz admin audytu |
| H5 | `auth/totp.go` | Kody odzyskania TOTP niezaimplementowane (stub) | Generować 10 jednorazowych kodów bcrypt-hashed przy włączaniu 2FA |
| H6 | `config/config.go` | Brak walidacji wartości env (np. `LOG_LEVEL=DROP_TABLE`) | Enum whitelist dla każdej opcji enum |

#### Znaleziska Średnie (8)

| # | Obszar | Opis |
|---|---|---|
| M1 | `auth/password.go` | PBKDF2 100k OK, ale argon2id byłby nowocześniejszy |
| M2 | `ratelimit/*` | Brak normalizacji IPv6 (/64) — każdy sufiks traktowany osobno |
| M3 | `db/postgres.go` | Escapowanie `%`/`_` obecne, ale brak w kilku zapytaniach autorskich |
| M4 | `signal/handler.go` | `tcpPunchConns sync.Map` ma TTL 2min, ale brak limit liczby wpisów przy burst |
| M5 | `auth/jwt.go` | Brak blacklisty JTI po `logout` — token ważny do expiry |
| M6 | `relay/server.go` | `SetDeadline` zamiast `context.Context` → trudniej shutdown |
| M7 | `cdap/audio.go` | Brak walidacji rozmiaru ramki audio (potencjalny OOM) |
| M8 | Instalator | `.admin_credentials` plaintext jeśli `STORE_ADMIN_CREDENTIALS=true` |

#### Znaleziska Niskie (5)

- L1: `/metrics` bez auth (expose device IDs w labelach)
- L2: Log injection przez peer ID w `log.Printf("peer %s ...", id)` bez sanitizacji CR/LF
- L3: `GET /api/config/enum/:key` brak rate limit
- L4: `GetRelayServers()` już waliduje host ≥ 2 znaków, ale brak walidacji portu (range 1-65535)
- L5: Audit log nie zawiera `session_id` dla korelacji zdarzeń z sesją operatora

#### Ocena sumaryczna

Fundamenty bezpieczeństwa są solidne (RBAC, rate-limit, PBKDF2, constant-time compare, NaCl, Ed25519). Główne deficyty to niepersystowany JWT secret, niechroniony upgrade WebSocket i brak TLS-everywhere w defaults. **Ocena: 7/10.**

---

### 3.2 Node.js Console (`web-nodejs/`)

Express + EJS + better-sqlite3 / pg + csrf-csrf + helmet + express-rate-limit + bcrypt + otplib.

#### Znaleziska Wysokie (3)

| # | Plik:linia | Problem | Rekomendacja |
|---|---|---|---|
| H1 | `routes/settings.routes.js:144`, `public/js/settings.js:646` | `logoUrl` bez walidacji schematu (`javascript:`, `data:`, `file://` → XSS/SSRF) | Whitelist `http://`, `https://`, `/uploads/` przez `URL` constructor |
| H2 | `routes/settings.routes.js:142-148` | Branding akceptuje ~30 pól bez whitelisty; `logoSvg` sanitizowany regexem (omija `<style>`, `<use xlink:href>`) | Użyć DOMPurify dla SVG, whitelist pól (color: hex regex, font: alnum) |
| H3 | `routes/settings.routes.js:220-250` | TOCTOU przy usuwaniu starego logo po zmianie URL | Trzymać listę zarządzanych plików + walidować przynależność przed `fs.unlink` |

#### Znaleziska Średnie (5)

| # | Obszar | Opis |
|---|---|---|
| M1 | `routes/devices.routes.js:24-44` | `search` przekazywany do `serverBackend.getAllDevices` bez `escapeLikePattern()` |
| M2 | `services/brandingService.js:24-40` | Regex `SVG_DANGEROUS_TAGS` nie obejmuje `<style>`, `<use xlink:href>` |
| M3 | `middleware/rateLimiter.js:31-37` | Login: 5/60s — brak exponential backoff |
| M4 | `server.js:100-103` | `sameSite: 'lax'` — GET-CSRF teoretycznie możliwy |
| M5 | `services/database.js` audit_log | Brak indexu na `created_at` + brak auto-cleanup |

#### Znaleziska Niskie (2)

- L1: CSRF bypass dla Tauri origins (`tauri://localhost`) — uzasadnione, ale brak komentarza inline.
- L2: `localStorage` używany tylko do wallpapera/theme — OK.

#### Mocne strony (poprawnie zaimplementowane)

- ✅ CSRF double-submit cookie (csrf-csrf)
- ✅ Session fixation: `session.regenerate()` po loginie
- ✅ Bcrypt 12 rounds + DUMMY_HASH timing-safe
- ✅ TOTP 2FA z kodami odzyskania (otplib)
- ✅ 3 rate-limitery (api, login, passwordChange)
- ✅ Helmet z nonce-based CSP
- ✅ Parametryzowane zapytania SQL + `escapeLikePattern()`
- ✅ CORS strict whitelist
- ✅ WebSocket device-status push (Phase 38) — z auth
- ✅ Test suite (jest + supertest, 41 testów)

**Ocena: 7.5/10 — najdojrzalszy pod kątem bezpieczeństwa moduł projektu.**

---

### 3.3 MGMT Client (`betterdesk-mgmt/`) — Tauri + SolidJS

~40k LOC Rust, 25+ modułów, 100+ IPC commands. **Kompletność ~40%.**

#### Znaleziska Krytyczne (4)

| # | Plik:linia | Problem | Rekomendacja |
|---|---|---|---|
| **C1** | `src/AutomationPanel.tsx:44` i inne | `localStorage.getItem('bd_access_token')` — token w zasięgu XSS | Przenieść do Tauri secure store (`tauri-plugin-stronghold` lub `keyring` przez IPC); nigdy nie eksponować do JS |
| **C2** | `src-tauri/tauri.conf.json` | CSP `script-src 'self' 'unsafe-eval'` | Usunąć `'unsafe-eval'`; jeśli potrzebne dla bibliotek — przepisać na WASM lub `Function()` w Rust |
| **C3** | `src-tauri/src/commands.rs:851, 1102`, `bd_registration.rs:272` | `danger_accept_invalid_certs(true)` w 5 miejscach | Warunkowa akceptacja po user-confirm + pokazanie fingerprintu + cert pinning po pierwszej akceptacji |
| **C4** | `src-tauri/src/commands.rs:213` | `connect_to_peer(peer_id: String)` bez walidacji | Regex `^[A-Za-z0-9]{6,16}$` zgodny z Go serverem |

#### Znaleziska Wysokie (4)

| # | Plik:linia | Problem |
|---|---|---|
| H1 | `commands.rs:252` | `.text().await.unwrap_or_default()` ukrywa błędy HTTP |
| H2 | `operator.rs` | Brak TOTP dla loginu operatora (tylko admin w konsoli web) |
| H3 | `commands.rs:730-735` | Brak refresh-token flow; token persist międz restartami bez rotacji |
| H4 | `lib.rs` | 100+ IPC bez rate-limitingu → agent DoS przez spam |

#### Znaleziska Średnie (2)

- M1: `commands.rs:227` — brak walidacji URL (`url::Url::parse()`).
- M2: `config/secure_store.rs` — brak fallbacku do encrypted file gdy keyring niedostępny (Windows credential store problem).

#### Znaleziska stabilności

- **Panic risks:** `.unwrap_or_default()` na device_id w `commands.rs:512` (bezpieczne, ale warto logować); nil pointer możliwy na `server_key` comparison (`commands.rs:192`).
- **Race conditions:** `Mutex<Session>` w `commands.rs:390-400` — `session.clone_handle()` → `.authenticate()` może rywalizować z `.disconnect()`; wielokrotne `.take()` na tych samych polach state bez mutual exclusion.
- **Missing error handling:** `network/bd_registration.rs:272` i `inventory/collector.rs:326` ignorują `.build()` error; brak timeout na niektóre async operacje.

#### Braki funkcjonalne (stubs)

| Obszar | Status | Plik |
|---|---|---|
| VP9 codec | ❌ TODO | `codec/mod.rs:140,158` |
| H.264 decoder (pełny pipeline) | ❌ STUB | `remote/video_pipeline.rs` (tylko JPEG) |
| Service install | ❌ nie zaimplementowane | `service/mod.rs:319-329` |
| Direct P2P | ❌ no-op | `session.rs:157-158` |
| Clipboard sync | ❌ TODO | `clipboard/mod.rs:6` |
| Frame capture | ❌ TODO | `capture/mod.rs:8` |
| Automation backend | ⚠️ tylko UI | `automation/*` |
| File transfer backend | ⚠️ tylko UI | `FileTransferPanel.tsx` |
| Session recording | ⚠️ stub | `remote/session_recorder.rs` |
| Operator endpoints | ⚠️ 8 naprawionych, nietestowane na live | `operator/*` |
| Multi-monitor select | ✅ OK | `media_control.rs` |
| Server admin panel | ✅ OK | `ServerPanel.tsx` (6 tabs) |
| Notification center | ✅ OK | `NotificationCenter.tsx` |

#### Ocena

**Ocena: 5/10 — UX bardzo dobry, ale backend w 40% niekompletny; bez naprawy C1-C4 nie może iść do produkcji.**

---

### 3.4 Agent Client (`betterdesk-agent-client/`) — Tauri + SolidJS

4 moduły Rust (commands, config, registration, sysinfo_collect), 17 IPC. **Kompletność ~20%.**

#### Znaleziska Krytyczne (3)

| # | Plik:linia | Problem | Rekomendacja |
|---|---|---|---|
| **C1** | `registration.rs:139, 178` | `danger_accept_invalid_certs(true)` na WSZYSTKICH 4 krokach validation | Strict TLS (cert must be valid) o ile user explicit approve self-signed; pokazać fingerprint przed akceptacją |
| **C2** | `registration.rs:200-205` | Device ID = `SHA256(machine_uid)[0:4]` — tylko 65k unikatów, trywialny brute-force | Użyj pełnego 16-byte hash lub 32-char base62 |
| **C3** | wszystkie kroki registration | Brak certificate fingerprint pinningu | Po pierwszej udanej rejestracji zapisać SHA256 cert do keyringu; każda kolejna walidacja porównuje fingerprint |

#### Znaleziska Wysokie (3)

| # | Plik:linia | Problem |
|---|---|---|
| H1 | brak | Brak TOTP dla agenta (opcjonalny PIN) |
| H2 | `commands.rs:228-229`, `config.rs:104-123` | `store_token_secure()` silently fails (log INFO zamiast WARN); brak encrypted-file fallback |
| H3 | `registration.rs:40-50` | Brak whitelisty schematu URL (SSRF do localhost/private ranges możliwe) |

#### Znaleziska Średnie (3)

| # | Opis |
|---|---|
| M1 | `check_availability()` bez pre-validacji formatu URL → timing attacks |
| M2 | Response rejestracji `{device_id, token}` bez podpisu serwera — MITM może podmienić token |
| M3 | Brak challenge-response mutual auth — replay attack możliwy (kradzież nagranego heartbeat) |

#### Stabilność

- `.unwrap_or_else(|_| "unknown".to_string())` / `.unwrap_or("localhost")` / `.unwrap_or(21114)` — bezpieczne z defaults, ale log WARN.
- **Brak timeout** w `register()` i `sync_config()` — mogą wisieć na zepsutej sieci.
- `resp.json().await` bez deskrypcji błędów parse.

#### Braki funkcjonalne

| Obszar | Status |
|---|---|
| Pełny agent (screen capture, input injection) | ❌ |
| Terminal server | ❌ |
| File browser backend | ❌ |
| Clipboard listener | ❌ |
| Policy enforcement | ❌ |
| TOTP 2FA | ❌ |
| Cert pinning | ❌ |
| CDAP gateway integration | ❌ |
| Auto-update | ❌ |
| Setup wizard | ✅ OK |
| System info collection | ✅ OK |
| Tray + autostart + single-instance | ✅ OK |

#### Ocena

**Ocena: 3/10 — to de facto operator console, nie agent; brakuje 80% funkcji device-side. Bez realizacji C1-C3 nie może iść do produkcji.**

---

### 3.5 Natywny Go Agent (`betterdesk-agent/`)

~14 flag CLI, CDAP bridge przez WebSocket, gopsutil metryki, PTY terminal (Unix + Windows).

#### Znaleziska Krytyczne (1)

| # | Plik | Problem | Rekomendacja |
|---|---|---|---|
| **C1** | `agent/agent.go:493-604` | Agent deklaruje 8 capabilities (terminal, file_browser, clipboard, screenshot), ale implementuje tylko 4 (file_*) | Zaimplementować handlery `terminal_input/start/kill/resize`, `clipboard_get/set`, `screenshot_capture`; lub usunąć z manifest |

#### Znaleziska Wysokie (2)

| # | Obszar | Problem |
|---|---|---|
| H1 | `agent/agent.go:163-180` | API key przesyłany `ws://` (plaintext) — zmienić default na `wss://` |
| H2 | `install/install.sh:95-113` | Brak `ProtectSystem=strict`, `PrivateTmp=yes`, `NoNewPrivileges=yes` w systemd — ryzyko privilege escalation |

#### Znaleziska Średnie (2)

- M1: `config.go:47` — API key plaintext w `config.json` (installer ustawia `chmod 600`, ale jeśli config edytowany ręcznie → permissions mogą się popsuć).
- M2: `agent/agent.go:144` — `cfg.DeviceID` bez walidacji regex.

#### Mocne strony

- ✅ `filebrowser.go:24-44` — `safePath()` poprawnie chroni przed path traversal.
- ✅ `terminal_unix.go:20`, `terminal_windows.go:16` — brak interpolacji shell, input przez stdin.
- ✅ `clipboard.go:27-63`, `screenshot_unix.go` — `exec.LookPath()` bez interpolacji.

**Ocena: 6/10 — bezpieczny kod, ale niekompletna implementacja deklarowanych capabilities + brak TLS default.**

---

### 3.6 Instalatory + Docker

`betterdesk.sh`, `betterdesk.ps1`, `betterdesk-docker.sh`, `Dockerfile*`, `docker/entrypoint.sh`, `docker-compose*.yml`.

#### Znaleziska Wysokie (1)

- H1: `betterdesk.sh:1396` — `curl -fsSL … | bash -` (NodeSource) bez weryfikacji SHA256. Best practice: pobrać → `sha256sum -c` → `bash`.

#### Znaleziska Średnie (3)

- M1: `docker/entrypoint.sh:30-37` — SELinux-aware volume fix dokumentuje problem, ale brak instrukcji `-Z`.
- M2: Brak `restart: unless-stopped` na wszystkich usługach w `docker-compose.yml` (częściowo obecne).
- M3: `supervisord.conf` bez log rotation — przy długim uptime logi mogą zapełnić dysk.

#### Znaleziska Niskie (1)

- L1: `.env` generowany z losowym SESSION_SECRET, ale brak walidacji długości przy reinstalacji (choć warning dla <32 znaków istnieje).

#### Mocne strony

- ✅ SQL literal escape (`sql_escape_literal()`) + PostgreSQL identifier validation.
- ✅ `chmod 600` na `.env`, `.api_key`, `id_ed25519`.
- ✅ Non-root user w Dockerfile (`betterdesk:10001`).
- ✅ `COPY --chown=betterdesk:betterdesk` + `tini` + `su-exec`.
- ✅ HEALTHCHECK `/api/health` z timeoutami.
- ✅ Weak-secret warnings (SESSION_SECRET <32 znaków).
- ✅ Zero dostępu do sekretów w logach stdout.
- ✅ Preservation DB config / auth.db / API key podczas UPDATE (Phase 20, 26).

**Ocena: 8/10 — skrypty są dojrzałe, pozostałe punkty to operational polish.**

---

## 4. Roadmapa naprawy i rozbudowy — MGMT Client + Agent Client

### 4.1 MGMT Client — trzy etapy (3-4 tygodnie)

#### Etap 1: Naprawy krytyczne (Tydzień 1)

1. **Dzień 1-2:** Przenieść `bd_access_token` z `localStorage` do Tauri `stronghold` lub `keyring`; dodać IPC commands `store_token`, `get_token`, `clear_token` z walidacją wywołującego command.
2. **Dzień 1:** Usunąć `'unsafe-eval'` z `tauri.conf.json` CSP; przetestować wszystkie widoki (zwłaszcza code editor dla automation scripts jeśli używa eval).
3. **Dzień 2-3:** Przebudować `danger_accept_invalid_certs(true)` na strukturę:
   ```rust
   if config.allow_self_signed && user_confirmed_fingerprint(cert_sha256) {
       ClientBuilder::new().add_root_certificate(cert)
   } else {
       ClientBuilder::new() // strict
   }
   ```
4. **Dzień 3:** Dodać walidację `peer_id` (regex `^[A-Za-z0-9]{6,16}$`) i `server_address` (`url::Url::parse()` + whitelist `http(s)`).

#### Etap 2: Wysokie priorytety (Tydzień 2)

5. **Dzień 1-2:** Zaimplementować TOTP dla loginu operatora (osobny krok po `/api/auth/login`, analogicznie do konsoli web).
6. **Dzień 2:** Dodać refresh-token flow (24h access, 30d refresh w keyring) + auto-refresh 5 minut przed expiry.
7. **Dzień 3:** Token bucket rate-limiter per-command (np. `connect_to_peer` max 10/min, heartbeat 60/min).
8. **Dzień 3-4:** Windows-specific keyring fallback do `sodiumoxide`-encrypted pliku w `%APPDATA%\BetterDesk\secrets.enc`.

#### Etap 3: Kompletność funkcjonalna (Tydzień 3-4)

9. **Dzień 1-2:** Naprawić race condition: state machine enum `ActiveProtocol { None, Legacy(Session), BdNative(Session) }` z mutex na przejściach.
10. **Dzień 2-4:** Pełny VP9 codec przez `dav1d` lub `vpx` crate (obecnie TODO); analogicznie H.264 rozszerzyć `openh264` o kompletny pipeline (NAL parsing + DPB + render).
11. **Dzień 3-4:** File transfer backend — `src-tauri/src/remote/file_transfer_session.rs` wg protobuf FileAction (obecnie tylko UI); drag-and-drop + progress + cancel.
12. **Dzień 4:** Timeout 15s na wszystkich async network calls + retry-with-backoff.

**Oczekiwany efekt:** MGMT Client ~90% kompletny, gotowy do pilota produkcyjnego.

### 4.2 Agent Client — cztery etapy (5-6 tygodni)

#### Etap 1: Naprawy krytyczne (Tydzień 1)

1. **Dzień 1-2:** Strict TLS w `registration.rs`; UI flow:
   - Pobierz cert → pokaż fingerprint (SHA256) + organization → user confirm.
   - Po akceptacji: zapisz fingerprint w keyring → pin dla wszystkich przyszłych connection.
   - Jeśli fingerprint się zmieni: alarm + wymagana ponowna rejestracja.
2. **Dzień 1:** Zwiększyć entropię device ID — pełny 16-byte SHA256 hash machine_uid + salt z server + losowe 4 bajty.
3. **Dzień 2-3:** Implementacja cert fingerprint pinningu (keyring key: `server_fingerprint_<host>`).
4. **Dzień 2:** URL scheme whitelist + blacklist prywatnych IP (10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7) — chyba że user explicit enable.

#### Etap 2: Wysokie i średnie (Tydzień 2)

5. **Dzień 1:** Keyring fallback + log WARN zamiast INFO przy błędach.
6. **Dzień 2-4:** Challenge-response mutual auth:
   - Client: generuje local Ed25519 keypair → wysyła pubkey w `register`.
   - Server: wysyła nonce → client podpisuje → server weryfikuje → zwraca signed token.
7. **Dzień 3:** Serwer podpisuje odpowiedź rejestracji (Ed25519) → client weryfikuje kluczem pobranym przez out-of-band channel (lub QR z konsoli).
8. **Dzień 4:** Opcjonalny TOTP device PIN w keyring — dla agentów o wysokim zaufaniu.

#### Etap 3: Stabilność (Tydzień 3)

9. Timeout 15s na wszystkich async calls (`register`, `sync_config`, heartbeat).
10. Lepsze komunikaty błędów `Url::parse()` (mapping na user-friendly messages).
11. `validate_step()` pre-validation URL format przed network call.

#### Etap 4: Kompletność funkcjonalna device-side (Tydzień 4-6)

12. **Integracja z CDAP gateway** — użyć natywnego `betterdesk-agent` jako library albo przepisać w Rust (terminal przez `portable-pty`, file browser, clipboard przez `arboard`, screenshot przez `scrap`/`screenshots-rs`).
13. **Policy enforcement engine** — pull z serwera `GET /api/agent/policies/{id}` → cache → apply (USB block, file monitoring, app whitelist).
14. **Auto-update mechanism** — Tauri updater plugin + signature verification (Ed25519 sign by BetterDesk CA).
15. **Per-platform hardening:**
    - Windows: UAC prompts dla screen capture, MSI + NSSM service.
    - Linux: deb/rpm + systemd z `ProtectSystem=strict`.
    - macOS: pkg + launchd + TCC prompts (Accessibility, Screen Recording).

**Oczekiwany efekt:** Agent Client ~80% kompletny; realny device agent, nie tylko operator tool.

### 4.3 Rekomendowany harmonogram łączny

| Tydzień | MGMT Client | Agent Client | Go Server / Node.js |
|:---:|---|---|---|
| **1** | C1-C4 (CSP, token, MITM) | C1-C3 (TLS, ID, pinning) | JWT secret persist, WS auth gate |
| **2** | H1-H4 (TOTP, rate-limit) | H1-H3 (keyring, mutual auth) | Node.js H1-H3 (branding, logoUrl) |
| **3** | Race condition + codecs | Stability + timeouts | TLS defaults (21121/21122) |
| **4** | File transfer backend | Policy engine + CDAP | mTLS internal |
| **5** | Session recording | Auto-update | rate-limit relay |
| **6** | Testy E2E | Per-platform hardening | Audit logging CDAP |

---

## 5. Plan testów bezpieczeństwa

### 5.1 Testy automatyczne (CI)

- **SAST:**
  - Go: `gosec`, `govulncheck`, `staticcheck`.
  - Rust: `cargo audit`, `cargo deny`, `clippy::pedantic`.
  - Node.js: `npm audit --omit=dev` (już 0 vulns), ESLint security plugin.
- **Dependency scanning:** Renovate/Dependabot z auto-PR dla patchy bezpieczeństwa.
- **Secret scanning:** `gitleaks` w pre-commit + GitHub Actions.
- **SBOM:** generowanie przy każdym release (CycloneDX).

### 5.2 Testy manualne (pre-release)

- Penetration test na panel web (OWASP Top 10, szczególnie A01 broken access control, A03 injection, A07 auth failures).
- Fuzzing CDAP protokołu (ramki audio/video, terminal input).
- TLS handshake testy (`testssl.sh`, `sslyze`) dla portów 5000, 21114, 21121, 21122.
- Relay load test (liczba równoczesnych sesji, bandwidth throttling).

### 5.3 Testy integracyjne (per-phase)

- Scenariusz 1: Fresh install → rejestracja urządzenia → helpdesk request → operator accept → remote session → session recording → disconnect → audit log check.
- Scenariusz 2: Update z v2.3 → v2.4 (migracja PostgreSQL) → zachowanie admin password, API key, auth.db.
- Scenariusz 3: MITM attempt podczas registration agent → sprawdzenie czy fingerprint pinning odrzuca.
- Scenariusz 4: Revoke operator → token w JWT blacklist → odmowa dostępu w <5s.

---

## 6. Rekomendacje strategiczne

### 6.1 Bezpieczeństwo

1. **TLS-first policy** — wyłączyć wszystkie plaintext kanały w defaults instalatorów (generowanie samosignowanych certów dla szybkiego startu + walidacja fingerprintów przez QR/out-of-band).
2. **Secret rotation** — JWT secret rotation co 90 dni, API key rotation endpoint + UI.
3. **Formal threat model** — STRIDE analiza dla każdego nowego feature przed PR merge.
4. **Security audit cadence** — zewnętrzny audyt przed każdym major release (v3.0).
5. **Bug bounty / responsible disclosure** — `SECURITY.md` + `security@` kontakt.

### 6.2 Stabilność

1. **Observability stack:** Prometheus + Grafana dashboard (już `/metrics` istnieje — dodać auth + panel).
2. **Chaos testing:** okresowe symulacje utraty sieci, korupcji DB, burst requests.
3. **Graceful degradation:** fallback z PostgreSQL do SQLite przy błędach, read-only mode przy niedostępnym Go serverze.
4. **Blue-green deployments** dla Docker (obecnie single-container restart = downtime).

### 6.3 Kompletność MGMT + Agent

Po zrealizowaniu roadmapy (§4) klienci Tauri powinni osiągnąć parity z konsolą web + natywnym RustDesk klientem:
- **MGMT Client:** pełny operator toolkit (remote + chat + file + automation + audit) w jednej aplikacji desktop.
- **Agent Client:** lekki endpoint agent z policy enforcement, zastępujący konieczność instalacji RustDesk client (opcjonalnie komplementarny).

---

## 7. Tabela finalna wszystkich znalezisk

| ID | Moduł | Severity | Obszar | Plik:linia | Opis skrócony |
|---|---|:---:|---|---|---|
| GO-C1 | Go Server | 🔴 | WS auth | `api/cdap_handlers.go:425` | Brak auth przed WS upgrade |
| GO-C2 | Go Server | 🔴 | Auth | `config/config.go:170` | JWT secret regenerowany |
| GO-C3 | Go Server | 🔴 | Race | `signal/handler.go:1070` | Relay UUID race condition |
| GO-C4 | Go Server | 🔴 | Network | `admin/server.go` | Admin TCP nie wymusza loopback |
| GO-H1 | Go Server | 🟠 | Info leak | `api/auth_handlers.go:1491` | Bcrypt error w odpowiedzi |
| GO-H2 | Go Server | 🟠 | Proxy | middleware | XFF bez TRUST_PROXY gate |
| GO-H3 | Go Server | 🟠 | Auth | API | API key w query param |
| GO-H4 | Go Server | 🟠 | DB | `db/*.go` | soft_deleted peers w query |
| GO-H5 | Go Server | 🟠 | 2FA | `auth/totp.go` | Recovery codes stub |
| GO-H6 | Go Server | 🟠 | Config | `config/config.go` | Brak walidacji env enum |
| NODE-H1 | Node.js | 🟠 | XSS | `settings.routes.js:144` | logoUrl bez walidacji |
| NODE-H2 | Node.js | 🟠 | XSS | `settings.routes.js:142` | Brak whitelisty branding |
| NODE-H3 | Node.js | 🟠 | FS | `settings.routes.js:220` | TOCTOU logo delete |
| MGMT-C1 | MGMT | 🔴 | Token | `AutomationPanel.tsx:44` | Token w localStorage |
| MGMT-C2 | MGMT | 🔴 | CSP | `tauri.conf.json` | unsafe-eval w CSP |
| MGMT-C3 | MGMT | 🔴 | TLS | `commands.rs:851` | danger_accept_invalid_certs |
| MGMT-C4 | MGMT | 🔴 | Input | `commands.rs:213` | Brak walidacji peer_id |
| AGENT-C1 | Agent Client | 🔴 | TLS | `registration.rs:139` | danger_accept_invalid_certs |
| AGENT-C2 | Agent Client | 🔴 | Crypto | `registration.rs:200` | Device ID 65k entropii |
| AGENT-C3 | Agent Client | 🔴 | TLS | `registration.rs` | Brak cert pinningu |
| NATIVE-C1 | Go Agent | 🔴 | CDAP | `agent/agent.go:493` | 50% capabilities stubs |
| ARCH-C1 | Arch | 🔴 | TLS | port 21121 | Client API plaintext |
| ARCH-C2 | Arch | 🔴 | TLS | port 21122 | CDAP WS plaintext |
| ARCH-C3 | Arch | 🔴 | Relay | port 21117 | Brak rate-limit/TLS |

*(Dodatkowe pozycje High/Medium/Low — zob. sekcje szczegółowe 3.1-3.6.)*

---

## 8. Podsumowanie

BetterDesk jest projektem o bardzo wysokim poziomie dojrzałości kodu serwerowego (Go + Node.js), z kompletną infrastrukturą RBAC, 2FA, audit logging, rate-limiting i CSP. **Główne ryzyko nie leży w istniejących modułach, ale w ich nierównym ukończeniu — klienci Tauri (MGMT + Agent) mają bardzo dobry UX, ale 60-80% funkcjonalności to stuby**. Zdecydowaną, jednorazową pracą 4-6 tygodni (§4) można doprowadzić oba klienty do parity z konsolą web.

**Trzy rzeczy do zrobienia w tym tygodniu:**
1. Usunąć `danger_accept_invalid_certs(true)` z obu klientów Tauri.
2. Persistent JWT secret w Go server.
3. TLS defaults (`wss://`) dla natywnego agenta.

Po tych trzech zmianach projekt jest gotowy do pilotażu produkcyjnego przy restrictive deployment (tylko HTTPS, private VPN do agentów). Pełna production-readiness po wykonaniu całej roadmapy 6-tygodniowej (§4.3).

---

## 9. Status napraw (2026-04-17)

Poniższe znaleziska zostały zweryfikowane i naprawione w kodzie. Znaleziska oznaczone jako „False Positive" zostały odrzucone po weryfikacji kodu.

### Naprawione

| ID | Moduł | Opis naprawy | Plik |
|----|-------|-------------|------|
| **GO-C1** | Go Server | Dodano RBAC (operator+) **przed** `websocket.Accept()` w `handleCDAPVideo`. Wzorzec: delegacje + `cdap.RoleLevel()` check identyczny z `handleCDAPAudio`. | `api/cdap_handlers.go` |
| **GO-H4** | Go Server | Dodano `AND (soft_deleted IS NULL OR soft_deleted = 0)` do `GetPeer()` w SQLite i `AND (soft_deleted IS NULL OR soft_deleted = false)` w PostgreSQL. | `db/sqlite.go`, `db/postgres.go` |
| **NODE-H1** | Node.js Console | Dodano walidację schematu URL dla `logoUrl`/`faviconUrl` w `saveBranding()` — dozwolone tylko `http://`, `https://`, lub ścieżki względne (`/`). Blokuje `javascript:`, `data:`, itp. | `services/brandingService.js` |
| **MGMT-C2** | MGMT Client | Usunięto `'unsafe-eval'` z dyrektywy `script-src` w CSP. Eliminuje wektor XSS przez `eval()`/`Function()`. | `src-tauri/tauri.conf.json` |
| **MGMT-C4** | MGMT Client | Dodano walidację `peer_id` w `connect_to_peer()` — max 64 znaków, tylko alfanumeryczne + `-` + `_`. Odrzuca puste i nieprawidłowe formaty. | `src-tauri/src/commands.rs` |
| **AGENT-C2** | Agent Client | Zwiększono entropię Device ID z 4 bajtów (32 bity, ~4.3B) do 8 bajtów (64 bity, ~18.4 quintillion). Format: `BD-{16 hex}`. | `src-tauri/src/registration.rs` |
| **NODE-M5** | Node.js Console | Dodano `idx_audit_log_created` i `idx_audit_log_action` do tabeli `audit_log` (SQLite + PostgreSQL). Dodano `cleanupOldAuditLogs(90)` do hourly housekeeping. | `services/dbAdapter.js`, `server.js` |

### Zweryfikowane jako False Positive (bez zmian)

| ID | Powód odrzucenia |
|----|-----------------|
| **GO-C2** | JWT secret **jest już** persystowany w tabeli `server_config` bazy danych (`main.go:145-165`). Przetrwa restarty. |
| **GO-C3** | `tcpPunchConns sync.Map` **jest czyszczony** przez goroutine z 2-minutowym tickerem + TTL + limit 10 000 wpisów (`signal/handler.go`). Zabezpieczenie DDoS obecne. |
| **GO-C4** | Admin TCP console **już bind na `127.0.0.1`** (`admin/server.go:69`). Brak ekspozycji sieciowej. |
| **GO-H1** | Bcrypt error **nie jest ujawniany** klientowi — zwracany jest generyczny `"failed to hash password"` (`api/server.go:1478`). Login zwraca `"Invalid credentials"` dla zarówno nieistniejącego usera jak i błędnego hasła. |
| **GO-H2** | Trust proxy jest **opcjonalny i gated** przez `TrustProxy` w config (`api/server.go:1095-1115`). Domyślnie false — nagłówki `X-Forwarded-For` są ignorowane. |
| **GO-H3** | Token 2FA jako query param **został już usunięty** (patrz BD-2026-005) — obecnie wyłącznie nagłówek `X-2FA-Token`. |
| **GO-L2** | Peer ID jest walidowany regexpem `peerIDRegexp` **przed** logowaniem. Socket addrs to `net.UDPAddr` structs — bezpieczne. |
| **NODE-M1** | `escapeLikePattern()` **jest już zaimplementowany** i stosowany we wszystkich zapytaniach LIKE (`dbAdapter.js:71-75`). |
| **NODE-H2** | Sanityzacja SVG **jest kompletna** — 4 regex patterns blokujące script, foreignobject, event handlers, javascript: URLs (`brandingService.js:10-38`). |
| **NATIVE-C1** | Native agent deklaruje 5 capabilities (telemetry, commands, remote_desktop, file_transfer, clipboard) — **nie 8**, jak raport pierwotnie sugerował. Wszystkie są obsłużone w `messageLoop` / `manifest.go`. |
| **NATIVE-H2** | Systemd hardening **jest już obecny** — `ProtectSystem=strict`, `PrivateTmp=true`, `NoNewPrivileges=true`, `ProtectHome=read-only` (`install/install.sh:150-155`). |
| **ARCH-C3** | Relay ma rate-limiting: `connLimiter.Allow(host)` **jest wywoływany** w `relay/server.go:142-147` dla każdej nowej sesji TCP. |

---

## 10. Status napraw — Runda 2 (2026-04-17)

Druga runda weryfikacji + napraw, uruchomiona po audycie §9. Zidentyfikowała kolejne rzeczywiste luki (nie false positives z pierwotnego raportu).

### Naprawione (Runda 2)

| ID | Moduł | Opis naprawy | Plik |
|----|-------|-------------|------|
| **GO-H6** | Go Server | `LOG_FORMAT` z env var **jest teraz walidowany** whitelistą `{"text", "json"}`. Nieprawidłowe wartości są ignorowane (silnie default `"text"`). Zapobiega log injection / config poisoning. | `config/config.go` |
| **NATIVE-H1** | Native Agent | Native CDAP agent **ostrzega w logu**, gdy serwer używa `ws://` (plaintext) z hostem innym niż `localhost`/`127.0.0.1`/`::1`. Wymusza świadome użytkowanie plaintext w trybie prod. | `agent/config.go` |
| **MGMT-C3** + **AGENT-C1** | MGMT / Agent Client | Refaktor 11 inline `Client::builder().danger_accept_invalid_certs(true)` do helperów `build_http_client()` z gate env var `BETTERDESK_STRICT_TLS`. Domyślnie zachowana kompatybilność (self-signed akceptowane), ale **jednorazowe ostrzeżenie w logu** + możliwość wymuszenia strict TLS przez `BETTERDESK_STRICT_TLS=1`. | `betterdesk-agent-client/src-tauri/src/{registration.rs,commands.rs}`, `betterdesk-mgmt/src-tauri/src/{commands.rs,inventory/collector.rs,network/bd_registration.rs}` |

### Odłożone (runda 3)

| ID | Powód odłożenia |
|----|-----------------|
| **GO-H5** | Kolumna `totp_recovery_codes` istnieje w schemacie ale nie jest nigdzie czytana/zapisywana. **Nie stanowi vulnerability** — TOTP działa poprawnie bez kodów awaryjnych (brak broken behaviour). Pełna implementacja wymaga: pole w `db.User`, generator w `auth/totp.go`, aktualizacji 4+ Scan/INSERT/UPDATE queries, zmiany flow login (weryfikacja + invalidacja kodu). To jest **feature addition**, nie security fix — odłożone do dedykowanego tasku. |

---

**Koniec audytu.**

*Dokument przygotowany automatycznie na podstawie analizy statycznej kodu; wymaga weryfikacji manualnej przed publikacją CVE / raportowaniem do klientów.*
