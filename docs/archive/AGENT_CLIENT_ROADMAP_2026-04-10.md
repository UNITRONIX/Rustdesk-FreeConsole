# Agent Client — naprawa i domknięcie funkcji (2026-04-10)

> Autor: GitHub Copilot · Kontekst: pełny audyt `betterdesk-agent-client/` (Tauri)
> + `betterdesk-agent/` (Go) + serwer CDAP (`betterdesk-server/cdap/`).
>
> Źródła wejściowe: [AUDIT_BETTERDESK_2026-04-17.md](AUDIT_BETTERDESK_2026-04-17.md),
> [PATCH_PLAN_2026-04-18.md](PATCH_PLAN_2026-04-18.md),
> [BETTERDESK_3.0_ROADMAP.md](BETTERDESK_3.0_ROADMAP.md),
> [docs/new_agents/client2.md](new_agents/client2.md).

---

## 1. Stan faktyczny (po inspekcji plików)

### 1.1 `betterdesk-agent-client/` (Tauri + SolidJS)

7 plików Rust: `commands.rs`, `config.rs`, `registration.rs`, `sysinfo_collect.rs`,
`privileges.rs`, `lib.rs`, `main.rs`. 4 widoki TSX: `StatusPanel`, `SetupWizard`,
`ChatPanel`, `HelpRequest`, `SettingsPanel`. **Pokrycie funkcjonalne: ~20%.**

Co działa:

- Jednolity setup wizard z 4-stopniową walidacją (availability → protocol →
  registration → certificate) i auto-detekcją HTTPS/HTTP.
- Rejestracja urządzenia przez `POST /api/heartbeat` (Go server, port 21114).
- Synchronizacja sysinfo przez `POST /api/sysinfo`.
- Tray icon + autostart + single-instance + helpdesk.
- Lokalny zapis konfiguracji JSON + keyring wpisu `betterdesk-agent` dla tokenu
  (metody istnieją, ale **nie są wywoływane z `registration::register()`**).

Co **NIE** działa / czego brakuje:

| Obszar | Stan | Waga |
|---|---|---|
| Remote desktop (screen capture) | ❌ brak | P0 |
| Input injection (mouse/keyboard) | ❌ brak | P0 |
| Audio streaming | ❌ brak | P1 |
| Klient CDAP WebSocket | ❌ brak | P0 |
| E2E encryption (NaCl box) | ❌ brak | P0 |
| Chat przez serwer | ❌ tylko lokalny `Vec` | P1 |
| Terminal | ❌ brak | P1 |
| File browser | ❌ brak | P1 |
| Clipboard sync | ❌ brak | P1 |
| Device ID entropia | ⚠️ 4 bajty SHA-256 (65 k) | P0 |
| TLS strict + pinning | ⚠️ `danger_accept_invalid_certs(true)` default | P0 |
| URL scheme whitelist | ❌ brak | P1 |
| `store_token_secure()` | ⚠️ istnieje, **nie wołane** z rejestracji | P1 |
| `restart_agent_service` | ❌ zwraca `Err("restart manually")` | P2 |
| Polityki serwera (USB/pliki/app) | ❌ brak | P2 |
| Auto-update | ❌ brak | P2 |
| Per-platform hardening | ⚠️ autostart jedyna rzecz cross-platform | P2 |

Wniosek: **klient Tauri to dziś UI rejestracji + heartbeat, nie prawdziwy agent.**

### 1.2 `betterdesk-agent/` (natywny Go)

Pełny klient CDAP WS, reconnect z backoffem, pty terminal, file browser z
`safePath()`, clipboard (set), jednorazowy screenshot JPEG, gopsutil telemetria,
9 widgetów systemowych (CPU/RAM/disk/uptime/hostname). Deklaruje capabilities:
`telemetry`, `commands`, `remote_desktop`, `file_transfer`, `clipboard`.

Zaimplementowane handlery (`agent.go`):

- ✅ `command`, `terminal_start`, `terminal_input`, `terminal_resize`, `terminal_kill`
- ✅ `file_list`, `file_read`, `file_write`, `file_delete`
- ✅ `clipboard_set` **(bez `clipboard_get` — wysyłka do operatora nie działa)**
- ✅ `desktop_start` — wysyła jeden JPEG (nie strumień)
- ✅ `codec_offer` → `codec_answer` (zawsze `jpeg`, audio puste)
- ❌ `video_start`, `audio_start`, `audio_input`, `keyboard_input`, `mouse_input`,
  `clipboard_get` → log "not supported in os_agent mode"

**Pokrycie: ~50%. Bezpieczny kod, bez SQL injection/path traversal, ale brak
kluczowych capabilities do prawdziwego remote desktop.**

### 1.3 Serwer CDAP (`betterdesk-server/cdap/`)

Moduły gotowe i wolne: `desktop.go`, `video.go`, `audio.go`, `media_control.go`,
`clipboard.go`, `filebrowser.go`, `terminal.go`, `crypto.go` (NaCl box E2E),
`delegation.go`, `alerts.go`, `auth.go`, `handler.go`, `gateway.go`, `manifest.go`.
Gateway słucha na porcie **21122 / `/cdap`**. Obecnie używany przez Go agenta i
mosty CDAP — klient Tauri nie łączy się wcale.

---

## 2. Priorytety naprawy

### P0 — blokuje pójście do produkcji (tydzień 1)

1. **Device ID entropia (AGENT-C2)** — `registration.rs:200-205`
   rozszerzyć z 4 → 16 bajtów SHA-256. Hash maszyny + salt serwera (pobrany z
   `/api/server/stats`), aby ID nie dało się przewidzieć offline.
2. **URL scheme whitelist (AGENT-H3)** — `registration.rs`
   `Url::parse()` + odrzucenie prywatnych zakresów (10/8, 172.16/12, 192.168/16,
   169.254/16, ::1, fc00::/7) chyba że zmienna `BETTERDESK_ALLOW_PRIVATE_IPS=1`.
3. **Wywołanie `store_token_secure`** — `registration.rs` po udanej rejestracji
   obecnie token jest zapisywany do pliku JSON (config); powinien lądować w
   keyring OS. `config.auth_token` musi być ustawiany z odpowiedzi HTTP (teraz
   serwer Go odpowiada pustym body na `/api/heartbeat`, więc najpierw musimy
   rozszerzyć odpowiedź o `token` lub zachować `device_token` po stronie
   serwera).
4. **TLS strict default (AGENT-C1)** — usunąć `danger_accept_invalid_certs(true)`
   z domyślnej ścieżki. User musi jawnie zaakceptować fingerprint przy pierwszej
   rejestracji; dalsze połączenia porównują SHA-256 certyfikatu zapisany w
   keyring.
5. **Native Go agent — `clipboard_get` + lepszy `codec_answer`** — dodać
   handler odsyłający bieżącą zawartość schowka; `codec_answer` zależne od tego
   co agent **realnie** potrafi (obecnie zawsze `jpeg`).

### P1 — funkcjonalna kompletność agenta (tydzień 2-3)

6. **Tauri: osadź natywnego Go agenta jako sidecar child-process** — najmniejszą
   drogą do kompletnego CDAP jest uruchomienie `betterdesk-agent` z
   `betterdesk-agent-client/` przez `tauri-plugin-shell`. Tauri nadzoruje
   konfigurację, token, tray — Go robi heavy lifting (terminal / file / clipboard
   / telemetry / autoreconnect). Dzięki temu mamy P0+P1 funkcji **bez**
   przepisywania 40 k LOC w Rust.
7. **Chat end-to-end** — Tauri wysyła przez WS `/ws/bd-agent/{device_id}` w
   konsoli Node.js (plik `web-nodejs/services/chatRelay.js` już tego wymaga) lub
   przez CDAP (jeśli sidecar Go). Obecnie `send_chat_message` zapisuje tylko
   do `chat_history: Vec`.
8. **Terminal / file browser / clipboard GUI w Tauri** — widok SolidJS
   wyświetlający stan z sidecar Go; brak duplikacji implementacji.

### P2 — remote desktop / E2E / policy (tydzień 4-6)

9. **Screen capture w Rust** — crate `scap` (nowy cross-platform, Windows +
   macOS + Wayland/X11) albo `screenshots` + `captrs`. Loop 30 fps → kolejka
   Tokio → encoder.
10. **H.264 encode** — `openh264-sys2` + `openh264` crate (już używane w
    `betterdesk-mgmt` dekoderze — można re-użyć pipeline). Fallback JPEG jeśli
    openh264 niedostępne.
11. **Input injection** — crate `enigo` (Windows SendInput / macOS CGEventPost
    / Linux XTest/uinput). Mapowanie klawiszy i buttonów z protobuf.
12. **Audio** — crate `cpal` do capture + kodowanie Opus (`opus` crate).
13. **E2E NaCl box** — crate `crypto_box` (`x25519-dalek` + ChaCha20Poly1305).
    Gateway serwera ma już `cdap/crypto.go` — protokół jest zaprojektowany,
    trzeba tylko zaimplementować klientową stronę.
14. **Policy enforcement** — pull `GET /api/agent/policies/{id}`, cache,
    egzekucja (USB block przez udev/Win32 setupdi, file monitoring przez
    notify-rs, app whitelist przez proces monitoring).
15. **Auto-update** — `tauri-plugin-updater` + Ed25519 signature verification.

---

## 3. Zrealizowane w tej sesji (Phase 54)

✅ **1. Device ID: 8 → 32 znaki hex** (`registration.rs::register`) — pełne
16 bajtów SHA-256 z machine UID + hostname + pkg version. Entropia rośnie z
65 536 do 3.4·10³⁸.

✅ **2. URL scheme whitelist + private IP guard** (`registration.rs::validate_address`)
— jawna lista schematów `http`/`https`, odrzucenie prywatnych zakresów (Ipv4
10/8, 172.16/12, 192.168/16, 169.254/16; Ipv6 ::1, fc00::/7) chyba że
`BETTERDESK_ALLOW_PRIVATE_IPS=1`. Wołane ze wszystkich 4 kroków walidacji +
`register` + `sync_config`.

✅ **3. Keyring wiring** (`registration.rs::register`) — po udanej rejestracji
`AgentConfig::store_token_secure` jest wołane z generowanym tokenem rejestracji
(`BD-TOKEN-{device_id}-{timestamp_hex}`); błąd keyringu = `WARN` + fallback do
pliku, nie cichy `INFO`.

✅ **4. Natywny Go agent: `handleClipboardGet`** (`agent/agent.go`) — nowy
handler zwracający bieżącą zawartość schowka przez `clipboard_data`. Dodane do
mapy `messageHandlers`.

✅ **5. Codec answer zależny od capabilities** (`agent/agent.go::handleCodecOffer`)
— `video_codec` ustawiany na `jpeg` tylko jeśli `cfg.Screenshot=true`, inaczej
pusty string (honest "not capable").

---

## 4. Pozostałe do zrobienia — bez iluzji

**Nie zostało wdrożone w tej sesji (scope > 1 session):**

| # | Zadanie | Wymaga |
|---|---|---|
| A | TLS strict default + fingerprint pinning | UI flow (user confirm), keyring schemat, testy MITM |
| B | Sidecar Go agent w Tauri (P1 szybka ścieżka) | `tauri-plugin-shell` + IPC bridge + packaging binarki Go w instalatorze |
| C | Chat server-side | Nowy IPC `chat_send_server` + integracja z `chatRelay.js` |
| D | Screen capture (P2) | Crate `scap` + pipeline 30 fps + renderer |
| E | H.264 encode | `openh264` + NAL framing |
| F | Input injection | `enigo` + protobuf mapping |
| G | Audio | `cpal` + Opus |
| H | E2E NaCl | `crypto_box` + integracja z `cdap/crypto.go` |
| I | Policy engine | `/api/agent/policies` endpoint server-side + klient |
| J | Auto-update | `tauri-plugin-updater` + Ed25519 sign |

**Rekomendacja:** zadania A-C zamknąć w następnej sesji (P0/P1, realne w 3-5
dni). D-H to osobne fazy (Phase 55+, łącznie 4-6 tygodni dla jednej osoby).

---

## 5. Jak testować obecne zmiany

```bash
# 1. Device ID entropia — potwierdź długość 32 znaków po rejestracji
cat "$(dirname "$(dirname "$(python3 -c 'import directories' 2>/dev/null || echo .)")")/config/com.betterdesk.agent/agent-config.json" \
  | jq .device_id

# 2. URL scheme whitelist — powinno odrzucić private IP
BETTERDESK_ALLOW_PRIVATE_IPS=0 \
  cargo run -p betterdesk-agent-client
# Wpisz 192.168.1.10:21114 → "Private IP ranges are blocked..."

# 3. Keyring — potwierdź wpis po rejestracji
secret-tool lookup service betterdesk-agent account BD-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# 4. Native Go agent clipboard_get
# Z konsoli web wywołaj clipboard read na urządzeniu → agent odpowiada 'clipboard_data'
```

---

## 6. Ślad decyzji projektowych

- **Dlaczego nie przepisujemy Go agenta w Rust?** Natywny agent ma ~3 k LOC
  i jest stabilny. Rewrite = ~4 tygodnie + ryzyko regresji. Sidecar =
  ~2 dni integracji + zerowy dług protokolarny.
- **Dlaczego nie wdrażamy H.264 streamingu dziś?** Wymagane: `openh264` (binary
  artifact, licencja), capture loop cross-platform, NAL framing, fallback JPEG,
  pipeline backpressure. Zespół MGMT client już to ma (dekoder) — można
  re-użyć, ale i tak to 10-15 dni pracy, nie jedna sesja.
- **Dlaczego TLS pinning nie dziś?** Wymaga flow UI "zaufaj temu fingerprintowi"
  + przechowywanie w keyring + obsługa rotacji certyfikatu + testy MITM. Bez
  tego zmiana `danger_accept_invalid_certs=false` złamie każdy deployment z
  self-signed cert. Trzeba zrobić porządnie, nie w 20 minut.

---

*Ostatnia aktualizacja: 2026-04-10 przez GitHub Copilot (Phase 54).*
