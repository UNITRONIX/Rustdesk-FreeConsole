# Audyt bezpieczeństwa BetterDesk pod produkcję firmową (2026-04-10)

**Zakres:** serwer Go (`betterdesk-server/`), konsola web Node.js (`web-nodejs/`), skrypty ALL-IN-ONE, obrazy Docker, zależności, konfiguracja deploymentu.

**Poza zakresem (na życzenie):** `betterdesk-mgmt/`, `betterdesk-agent-client/`, `betterdesk-agent/` — klienci desktop w fazie alpha.

**Metodologia:** statyczna analiza kodu, mapowanie powierzchni ataku, weryfikacja OWASP Top 10 2021, sprawdzenie zależności i konfiguracji domyślnych.

**Werdykt ogólny:** projekt ma **dobrą bazę bezpieczeństwa** (RBAC, CSRF, helmet/CSP, rate-limiting, audit log, HSTS, parametryzowane zapytania SQL, PBKDF2 dla Go, bcrypt cost 12 dla Node), ale **nie nadaje się jeszcze do bezpośredniej ekspozycji na Internet w produkcji firmowej bez wprowadzenia poprawek z sekcji „Krytyczne" i „Wysokie"**. Najpoważniejsze problemy to brak walidacji `Origin` na WebSocketach (CSWSH), obejście CSRF dla zaufanych originów Tauri (spoofowalne), automatyczne tworzenie lokalnego użytkownika po sukcesie logowania na serwerze Go oraz nieaktualne / podatne zależności Node.

---

## 1. Podsumowanie ustaleń

| Sev. | # | Komponent | Tytuł |
|------|---|-----------|-------|
| 🔴 KRYT | C-01 | Node.js (`services/wsRelay.js`, `chatRelay.js`, `remoteRelay.js`, `bdRelay.js`, `cdapMediaProxy.js`, `cdapTerminalProxy.js`) | Brak walidacji nagłówka `Origin` na uwierzytelnianych WebSocketach → CSWSH |
| 🔴 KRYT | C-02 | Node.js (`server.js`) | CSRF jest pomijane gdy `Origin` pasuje do "zaufanej" listy Tauri — `Origin` jest kontrolowane przez klienta non-browser |
| 🔴 KRYT | C-03 | Node.js (`web-nodejs/package.json`) | Nieaktualne / podatne zależności (`multer 1.x`, `express 4.18.2`, `protobufjs ^8.0.0` nie istnieje, brak `npm audit` w CI) |
| 🟠 WYS | H-01 | Node.js (`services/authService.js`) | Auto-tworzenie lokalnego konta po sukcesie auth na serwerze Go → eskalacja przywilejów przy kompromitacji Go |
| 🟠 WYS | H-02 | Node.js (`routes/bd-api.routes.js`) | Endpointy `/api/bd/*` akceptują autentykację przez session cookie a CSRF jest dla nich wyłączony → CSRF na operacjach operatora |
| 🟠 WYS | H-03 | Go (`api/auth_handlers.go::authMiddleware`) | `/api/branding`, `/api/devices/register`, `/api/devices/register/status`, `/ws/bd-mgmt/*` publiczne bez rate-limitu na pojedynczych endpointach |
| 🟠 WYS | H-04 | Node.js (`config/config.js`) | Opcja `RUSTDESK_API_DISABLE_TOTP=true` wyłącza 2FA na porcie WAN 21121 — brak twardych zabezpieczeń przy włączeniu |
| 🟠 WYS | H-05 | Go (`auth/password.go`) | Własna implementacja PBKDF2 zamiast `golang.org/x/crypto/pbkdf2`; 100 000 iteracji to poniżej rekomendacji OWASP 2023 (600 000) |
| 🟡 ŚR  | M-01 | Go (`auth/jwt.go`) | Ręczna implementacja JWT — brak walidacji `nbf`, `aud`, `iss`; brak rotacji secret JWT |
| 🟡 ŚR  | M-02 | Node.js (`middleware/security.js`) | CSP ma `'unsafe-inline'` dla `scriptSrcAttr` i `'unsafe-eval'` dla `/remote*` |
| 🟡 ŚR  | M-03 | Node.js (`middleware/rateLimiter.js`) | `apiLimiter.skip()` pomija limit dla widgetów na podstawie `Referer` (kontrolowany przez klienta) |
| 🟡 ŚR  | M-04 | Skrypty (`betterdesk.sh:4569`) | `eval "$cmd"` w narzędziu migracji — potencjalne shell injection przy ścieżkach ze spacjami / metaznakami |
| 🟡 ŚR  | M-05 | Skrypty (`betterdesk.sh:1515, 3108`) | Hasła admina generowane `openssl rand -base64 12 \| tr -d '/+=' \| head -c 16` — efektywnie ~88 bit i czasem <16 znaków |
| 🟡 ŚR  | M-06 | Node.js (`routes/system.routes.js`) | `/api/logs/recent`, `/api/system/info`, `/api/database/stats`, `/api/docker/containers` wymagają tylko `requireAuth` — wycieki informacji do roli `viewer` |
| 🟡 ŚR  | M-07 | Go (`api/auth_handlers.go`) | `tryGoServerAuth`/PBKDF2 fallback przyjmuje hasła do 128 znaków; brak globalnego limitu prób per-user (tylko per-IP) |
| 🟢 NIS | L-01 | Konfig (`server.js`) | `TRUST_PROXY=false` domyślnie — za reverse proxy rate-limit i audit log używają błędnego IP |
| 🟢 NIS | L-02 | Docker (`docker/supervisord.conf`) | `user=root` dla supervisord; OK dla procesu rodzica, ale brak `no-new-privileges` w docker-compose |
| 🟢 NIS | L-03 | Skrypty | `curl ... \| bash -` przy instalacji Node.js i Rust z NodeSource/rustup — brak pinningu sumy SHA |
| 🟢 NIS | L-04 | Go | Logowanie pełnych ścieżek URL z PII (peer ID, hostname) w `authMiddleware` |
| ℹ️ INFO | I-01 | Konfig | `HOST=127.0.0.1` domyślnie (dobrze); `API_HOST=127.0.0.1` dla portu 21121 — wymaga reverse proxy z TLS dla ekspozycji WAN |
| ℹ️ INFO | I-02 | Go | Brak globalnego limitu wielkości WebSocket payload na CDAP / mgmt |
| ℹ️ INFO | I-03 | Go | Brak rotacji `id_ed25519` (klucze serwerowe są długoterminowe — udokumentować) |
| ℹ️ INFO | I-04 | Brak | Brak `SECURITY.md` z procedurą zgłaszania luk |

**Mapowanie OWASP Top 10 2021:** A01 (C-02, H-02), A02 (H-05, M-05), A03 (M-04), A04 (H-01, H-04), A05 (M-02, L-02, L-03), A07 (M-07), A08 (C-03), A09 (M-06, L-04), A10 — brak SSRF w głównych ścieżkach.

---

## 2. Krytyczne (do naprawy przed produkcją)

### C-01 — Brak walidacji `Origin` na WebSocketach (CSWSH)

**Pliki:** [web-nodejs/services/wsRelay.js](web-nodejs/services/wsRelay.js#L70), [web-nodejs/services/chatRelay.js](web-nodejs/services/chatRelay.js#L499), [web-nodejs/services/remoteRelay.js](web-nodejs/services/remoteRelay.js#L250), [web-nodejs/services/bdRelay.js](web-nodejs/services/bdRelay.js#L211)

**Opis:** Wszystkie handlery `server.on('upgrade', ...)` w konsoli Node.js weryfikują sesję (`req.session.userId`), ale **nie sprawdzają nagłówka `Origin`**. SOP (Same-Origin Policy) **nie chroni** WebSocketów — przeglądarka pozwoli stronie atakującego (`evil.example.com`) otworzyć `ws://panel.firma.pl/ws/remote`, wysyłając ciasteczko sesyjne uwierzytelnionego operatora.

**Konsekwencje:** Cross-Site WebSocket Hijacking. Atakujący przejmuje aktywną sesję operatora → może wykonać operacje na zdalnym pulpicie, zobaczyć ekran, wysłać input, ściągnąć dane z chatu, ściągnąć kanały CDAP.

**Reprodukcja:**
1. Operator zalogowany w panelu, sesja aktywna.
2. Operator odwiedza stronę `evil.example.com` (np. przez phishing).
3. Strona uruchamia: `new WebSocket('wss://panel.firma.pl/ws/remote?device=BD-XXXX')`.
4. Przeglądarka dołącza ciasteczko `bd.sid` → upgrade przechodzi → `req.session.userId` jest ustawione → połączenie akceptowane.

**Naprawa:** Sprawdzać `request.headers.origin` we wszystkich handlerach `upgrade` (whitelista). Przykład:

```js
const ALLOWED_WS_ORIGINS = (process.env.WS_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin || '';
  if (ALLOWED_WS_ORIGINS.length && !ALLOWED_WS_ORIGINS.includes(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  // ... reszta walidacji sesji
});
```

Dla połączeń z Tauri (klienty bez Origin) → wymagać Bearer token zamiast cookie.

---

### C-02 — CSRF pomijane na podstawie spoofowalnego `Origin`

**Plik:** [web-nodejs/server.js](web-nodejs/server.js)

**Opis:** W middleware CSRF logika `skipCsrf` zwalnia z double-submit cookie wszystkie żądania, których `Origin` pasuje do listy `http://localhost:1420`, `tauri://localhost`, `https://tauri.localhost`. Nagłówek `Origin` jest **w pełni kontrolowany** przez non-browser HTTP klienty (curl, Postman, skrypt atakujący). Przeglądarka go nie ustawi dla cross-origin POST jeśli atakujący nie chce.

**Konsekwencje:** CSRF bypass dla wszystkich endpointów mutujących, jeśli atakujący wykona żądanie z dowolnego klienta non-browser. Mniej krytyczne niż klasyczne CSRF (atakujący nie ma sesyjnego ciasteczka ofiary z zewnątrz), ale **w połączeniu z C-01 lub XSS** pozwala na pełen łańcuch ataku.

**Naprawa:** Zamiast zwolnienia po `Origin`, zwolnić po obecności nagłówka `X-BetterDesk-Client: tauri` ustawionego z sekretem (HMAC tokena instalacji). Albo — preferowane — wymagać CSRF tokena dla wszystkich klientów, w tym Tauri (Tauri może go pobrać z `/api/auth/me`).

---

### C-03 — Nieaktualne / podatne zależności Node.js

**Plik:** [web-nodejs/package.json](web-nodejs/package.json)

| Pakiet | Wersja | Problem |
|--------|--------|---------|
| `multer` | `^1.4.5-lts.1` | EOL od 2024-03; **multer 2.x** to obecny stabilny. Wersja 1.x ma niezałatane CVE (prototype pollution, denial of service). |
| `express` | `^4.18.2` | Aktualna 4.x to 4.21.x; w 4.18 są CVE w `path-to-regexp` (DoS), `cookie` (CVE-2024-47764). Override `path-to-regexp: ^0.1.13` częściowo łagodzi. |
| `protobufjs` | `^8.0.0` | **Nie istnieje wersja 8.x**. Najnowsza to 7.4.x. To powoduje albo błąd instalacji albo pull arbitralnej wersji z npm. |
| `qrcode` | `^1.5.4` | Aktualna; OK ale audytować przy każdej aktualizacji. |
| `tweetnacl` | `^1.0.3` | Nie jest aktualizowane od 2020; rozważyć migrację na `@noble/curves`. |
| `axios` | `^1.7.7` | Aktualna `^1.9.x`, brak znanych krytycznych CVE w 1.7.7, ale lepiej podbić. |
| `node-pty` | `^1.0.0` (opt) | OK |

**Naprawa:**
1. Podbić `multer` do `^2.0.0`, `express` do `^4.21.2`, naprawić `protobufjs` na `^7.4.0`.
2. Uruchomić `npm audit --omit=dev` i naprawić wszystkie HIGH/CRITICAL.
3. Dodać do CI: `npm audit --omit=dev --audit-level=high` jako blokujący krok.
4. Dla `betterdesk-server/go.mod` uruchomić `govulncheck ./...` w CI.

---

## 3. Wysokie

### H-01 — Auto-create-local-user fallback w `tryGoServerAuth`

**Plik:** [web-nodejs/services/authService.js](web-nodejs/services/authService.js#L200)

**Opis:** Jeżeli logowanie do lokalnej bazy Node nie powiedzie się, `authService` próbuje auth przez serwer Go (`/api/auth/login`). Po sukcesie **automatycznie tworzy lokalne konto** z rolą zwróconą przez Go. Oznacza to: kompromitacja serwera Go = automatyczne tworzenie kont admin w panelu Node.

**Naprawa:** Wyłączyć auto-create domyślnie. Dodać flagę `BETTERDESK_AUTH_AUTOCREATE=false` jako default. Wymagać explicit provisioning konta przez admina przed pierwszym logowaniem.

### H-02 — CSRF wyłączony dla `/api/bd/*` przy auth sesyjnej

**Plik:** [web-nodejs/routes/bd-api.routes.js](web-nodejs/routes/bd-api.routes.js#L134)

**Opis:** `requireDeviceAuth` akceptuje **Bearer token lub session cookie**. CSRF jest pomijane dla tej trasy (zakłada się Bearer). Przeglądarka atakującego trafia w POST `/api/bd/operator/sessions` z cookie sesyjnym → operacja wykonana.

**Naprawa:** Dla ścieżek `/api/bd/*` odrzucić session-cookie auth — wymagać wyłącznie Bearer. Albo włączyć CSRF dla nich gdy obecne jest ciasteczko sesyjne.

### H-03 — Publiczne endpointy Go bez per-endpoint rate-limitu

**Plik:** [betterdesk-server/api/auth_handlers.go](betterdesk-server/api/auth_handlers.go#L850)

**Lista publiczna:** `/api/health`, `/metrics`, `/api/auth/login`, `/api/auth/login/2fa`, `/api/server/pubkey`, `/api/server/stats`, `/api/login`, `/api/login-options`, `/api/logout`, `/api/heartbeat`, `/api/sysinfo`, `/api/sysinfo_ver`, `/api/branding`, `/api/org/login`, `/ws/bd-mgmt/*`, `/api/devices/register`, `/api/devices/register/status`.

Większość ma rate-limit (loginLimiter, heartbeatLimiter), ale `/metrics`, `/api/branding`, `/api/devices/register*`, `/ws/bd-mgmt/*` — nie. `/metrics` w Prometheus może wyciekać metryki biznesowe; `/ws/bd-mgmt/*` jest WS uwierzytelniany dalej w handlerze, ale samo `upgrade` może być spamowane.

**Naprawa:** Owijać każdy endpoint publiczny w lokalny limiter (np. `enrollmentLimiter` dla `/api/devices/register`). Ograniczyć `/metrics` do whitelisty IP lub wymagać auth scoped do `metrics.view`.

### H-04 — `RUSTDESK_API_DISABLE_TOTP` jako ścieżka obejścia 2FA

**Plik:** [web-nodejs/config/config.js](web-nodejs/config/config.js)

**Opis:** Issue #104 wprowadziło flagę `RUSTDESK_API_DISABLE_TOTP=true` która **wyłącza TOTP wyłącznie na porcie 21121 (RustDesk Client API, WAN-facing)**. Konsola panelu (5000) nadal wymaga TOTP. Komentarz w kodzie ostrzega o ryzyku, ale operator może to ustawić nieświadomie.

**Naprawa:** 
1. Wymagać dodatkowej flagi `RUSTDESK_API_DISABLE_TOTP_ACKNOWLEDGED=true` w `.env`.
2. Logować ostrzeżenie na startupie banner: `⚠️ TOTP DISABLED ON WAN PORT 21121`.
3. Dokumentacja: wymagana firewall do whitelisty IP klientów na 21121, dedykowane konto serwisowe z minimalnymi uprawnieniami.

### H-05 — Własny PBKDF2, niska liczba iteracji

**Plik:** [betterdesk-server/auth/password.go](betterdesk-server/auth/password.go#L15)

**Opis:** `pbkdfIterations = 100_000` z SHA-256. OWASP 2023 dla PBKDF2-SHA256 rekomenduje **600 000**. Dodatkowo to **własna implementacja PBKDF2** zamiast stdlib `golang.org/x/crypto/pbkdf2`.

**Naprawa:**
1. Zastąpić własną implementację `golang.org/x/crypto/pbkdf2.Key(...)`.
2. Podnieść iteracje do **600 000** (lub przejść na Argon2id / scrypt — `golang.org/x/crypto/argon2`).
3. Dodać auto-migrację: przy poprawnym logowaniu jeśli hash używa starych parametrów, przeliczyć z nowymi.

---

## 4. Średnie (skrócona lista)

### M-01 — Ręczny JWT bez `nbf`/`iss`/`aud`
**Plik:** [betterdesk-server/auth/jwt.go](betterdesk-server/auth/jwt.go). Polecam `github.com/golang-jwt/jwt/v5`. Dodać `iss=betterdesk`, `aud` per service, walidację `nbf`.

### M-02 — CSP: `unsafe-inline` dla `scriptSrcAttr`, `unsafe-eval` dla `/remote*`
**Plik:** [web-nodejs/middleware/security.js](web-nodejs/middleware/security.js). Refaktoryzować inline event handlers w EJS do nazwanych funkcji JS i dołączać `addEventListener`. Dla `/remote*` rozważyć WASM-only protobuf żeby zlikwidować `unsafe-eval`.

### M-03 — `apiLimiter.skip()` po `Referer`
**Plik:** [web-nodejs/middleware/rateLimiter.js](web-nodejs/middleware/rateLimiter.js). `Referer` jest kontrolowany przez klienta. Zamiast tego: dedykowany endpoint widgetów z osobnym limiterem (np. 600/min) bez `skip`.

### M-04 — `eval "$cmd"` w `betterdesk.sh`
**Plik:** [betterdesk.sh:4569](betterdesk.sh#L4569). Przepisać na array execution:
```bash
local args=("-mode" "nodejs2go" "-src" "$src_db")
[ -f "$auth_db" ] && args+=("-node-auth" "$auth_db")
[ -n "$dst_db" ] && args+=("-dst" "$dst_db")
"$migrate_bin" "${args[@]}"
```

### M-05 — Słabsze hasła admina z `head -c 16`
**Pliki:** [betterdesk.sh:1515](betterdesk.sh#L1515), [betterdesk.sh:3108](betterdesk.sh#L3108). Generować: `openssl rand -base64 24 | tr -d '/+=' | head -c 20` (≥120 bit entropii). Albo `openssl rand -hex 16` (128 bit, jednoznaczna długość 32 znaków).

### M-06 — Endpointy systemowe dostępne dla `viewer`
**Plik:** [web-nodejs/routes/system.routes.js](web-nodejs/routes/system.routes.js#L111). Dodać `requirePermission('metrics.view')` lub `requireRole('operator')` do `/api/logs/recent`, `/api/system/info`, `/api/database/stats`, `/api/docker/containers`.

### M-07 — Brak per-username rate-limitu dla loginów
**Plik:** [betterdesk-server/api/auth_handlers.go](betterdesk-server/api/auth_handlers.go). `loginLimiter.Allow(clientIP)` — przy NAT cała sieć dzieli limit. Dodać równoległy `loginLimiter.Allow("user:"+body.Username)`.

---

## 5. Niskie / Informacyjne

- **L-01** — `TRUST_PROXY=false` domyślnie. Dokumentować w `.env.example` i sprawdzić w startup-checks.
- **L-02** — `supervisord` jako root w kontenerze. Dodać do `docker-compose.yml`:
  ```yaml
  security_opt: [no-new-privileges:true]
  read_only: true
  tmpfs: [/tmp]
  cap_drop: [ALL]
  ```
- **L-03** — `curl ... | bash` przy NodeSource/rustup. Rozważyć dystrybucję ze statycznych binarek z pinningiem SHA-256.
- **L-04** — Logowanie pełnych URL w Go zawiera peer ID, hostname → możliwy wyciek PII do logów systemowych.
- **I-01** — Zachować domyślne `127.0.0.1` na 5000; eksponować przez nginx z TLS + WAF.
- **I-04** — Dodać `SECURITY.md` z PGP key i procedurą zgłaszania luk.

---

## 6. Rekomendowane kroki przed wdrożeniem produkcyjnym

**Must-have (blokujące wdrożenie):**
1. ✅ Naprawić C-01 (Origin check dla wszystkich WS upgrade)
2. ✅ Naprawić C-02 (usunąć/utwardzić Origin-based CSRF bypass)
3. ✅ Naprawić C-03 (`npm audit fix`, podbicie `multer`, `express`, `protobufjs`)
4. ✅ Naprawić H-01 (wyłączyć auto-create-local-user)
5. ✅ Naprawić H-02 (Bearer-only dla `/api/bd/*` albo CSRF dla cookie auth)
6. ✅ Naprawić H-05 (PBKDF2 stdlib + 600k iteracji lub Argon2id)

**Should-have (1-2 tygodnie po wdrożeniu):**
7. ✅ H-03, H-04, M-01–M-07

**Operacyjne (deployment hardening):**
- Reverse proxy nginx / Caddy z TLS terminacją, HTTP/2, HSTS preload.
- `TRUST_PROXY=true` + nginx `proxy_set_header X-Real-IP`.
- WAF przed portem 21121 (RustDesk Client API).
- Firewall: 5000 tylko lokalnie, 21114/21116/21117/21118/21119 publiczne, 21121 z whitelistą lub VPN.
- `STORE_ADMIN_CREDENTIALS=false` (default secure od Phase 15).
- Konfiguracja `WS_ALLOWED_ORIGINS=https://panel.firma.pl,tauri://localhost`.
- Logi do SIEM / ELK + retencja audit logów ≥1 rok.
- Backup `auth.db` + `db_v2.sqlite3` (lub PG dump) z szyfrowaniem at-rest.
- Monitoring: Prometheus `/metrics` za auth, alerty na `login_failed`, `banned`, `2fa_failed` z porogiem.
- Plan rotacji: hasła admina co 90 dni, `id_ed25519` przy podejrzeniu kompromitacji (wymaga reset wszystkich klientów).
- Dodać `SECURITY.md` + workflow GitHub Actions z `npm audit` i `govulncheck`.

**Niezbędne testy przed go-live:**
- Penetration test zewnętrznego pentestera (focus: C-01, C-02, H-02).
- Test obciążeniowy heartbeat / signal na docelowy wolumen (~urządzenia × 1 heartbeat / 15s).
- Test failover PostgreSQL (LISTEN/NOTIFY, replikacja).
- Test backup/restore z `data/backups/`.
- Test pełnego cyklu uwierzytelniania z 2FA + recovery codes.

---

## 7. Podsumowanie wykonawcze

BetterDesk **nie nadaje się** w obecnym stanie (commit `2026-04-21`) do **bezpośredniej ekspozycji na publiczny Internet** w środowisku produkcyjnym firmy.

Po naprawie 6 pozycji blokujących (C-01, C-02, C-03, H-01, H-02, H-05) projekt **kwalifikuje się do wdrożenia za reverse-proxy z TLS i WAF**, przy obowiązkowym wdrożeniu wszystkich pozycji "Should-have" w pierwszym miesiącu.

Pozytywne aspekty: solidne RBAC (Phase 52/52b: 7 ról + 28 uprawnień), prawidłowo zaimplementowane CSRF (double-submit), audit log z ring buffer, parametryzowane zapytania SQL (allowlista kolumn w `UpdatePeerFields`), zarządzanie kluczami (klucze 0600), regeneracja sesji po loginie i TOTP, timing-safe porównanie haseł, walidacja peer ID przez regex, HSTS, `httpOnly` cookies, multi-stage Docker images z non-root user.

Następne kroki: wpiąć `npm audit` i `govulncheck` do CI, włączyć Dependabot dla `web-nodejs/package.json` i `betterdesk-server/go.mod`, wykonać external pentest po naprawie pozycji blokujących.
