# BetterDesk Agent Client — Roadmap (2026-04-21)

> Cel: uczynić `betterdesk-agent-client` (Tauri v2 + SolidJS) w pełni
> funkcjonalnym **agentem zdalnego zarządzania** działającym niewidocznie w tle
> systemu operacyjnego (tray, bez wpisu na pasku zadań) — odpowiednik RustDesk
> desktop działający po stronie zarządzanego urządzenia.
>
> Klient operatora to **wyłącznie** `betterdesk-mgmt` (Tauri v2, osobna aplikacja).
> `betterdesk-agent-client` jest widoczny dla użytkownika końcowego tylko przez
> ikonę tray i opcjonalne okno ustawień.

---

## 1. Architektura docelowa

```
┌─────────────────────────────────────────────────────┐
│   betterdesk-agent-client (Tauri, widoczny w tray)  │
│                                                     │
│  ┌─────────────────┐   ┌────────────────────────┐  │
│  │  UI / Tray      │   │  Sidecar Manager (Rust)│  │
│  │  SolidJS 4 tabs │   │  (sidecar.rs)          │  │
│  │  SetupWizard    │   │  start / stop / monitor│  │
│  │  StatusPanel    │   │  exponential backoff   │  │
│  │  ChatPanel      │   └──────────┬─────────────┘  │
│  │  SettingsPanel  │              │spawn + watch    │
│  └─────────────────┘              ▼                 │
│                          ┌────────────────┐         │
│                          │ betterdesk-    │         │
│                          │ agent (Go bin) │         │
│                          │ CDAP WS client │         │
│                          └───────┬────────┘         │
└──────────────────────────────────┼──────────────────┘
                                   │ ws://host:21122/cdap
                          ┌────────▼────────┐
                          │ BetterDesk      │
                          │ Server (Go)     │
                          │ CDAP Gateway    │
                          └────────┬────────┘
                                   │
                          ┌────────▼────────┐
                          │ betterdesk-mgmt │
                          │ (Operator)      │
                          └─────────────────┘
```

### Kluczowe zasady

| # | Zasada |
|---|--------|
| 1 | Agent **nigdy** nie pojawia się na pasku zadań (`skipTaskbar: true` w `tauri.conf.json`) |
| 2 | Okno agenta jest domyślnie ukryte — pojawia się tylko gdy użytkownik kliknie ikonę tray lub dwukliknie |
| 3 | Ciężka logika (CDAP, terminal, file browser, capture) = **Go sidecar** `betterdesk-agent` |
| 4 | Tauri zarządza: rejestracją, konfiguracją, tray, keyring, UI użytkownika, dialog zgody |
| 5 | Operator widzi i kontroluje urządzenie **przez serwer**, nie bezpośrednio przez agenta |
| 6 | Zgoda użytkownika przed sesją zdalną kontrolowana przez `require_consent` (Ustawienia) |

---

## 2. Stan obecny (2026-04-21)

### 2.1 Co działa

| Komponent | Stan |
|-----------|------|
| Tray icon (ukryty w pasku zadań) | ✅ `skipTaskbar: true` |
| Okno ukryte domyślnie | ✅ `visible: false` |
| Setup wizard (5-step walidacja) | ✅ HTTP REST |
| Rejestracja przez `/api/heartbeat` | ✅ |
| Device ID 16 bajtów entropii | ✅ (Phase 54) |
| URL whitelist + private IP guard | ✅ (Phase 54) |
| Keyring (OS) token storage | ✅ (Phase 54) |
| Sysinfo przez `/api/sysinfo` | ✅ |
| Single instance | ✅ tauri-plugin-single-instance |
| Autostart | ✅ tauri-plugin-autostart |
| Chat (lokalny bufor) | ⚠️ brak połączenia z serwerem |
| Help request | ✅ HTTP POST |

### 2.2 Nowe w tej sesji (Phase 55)

| Komponent | Plik | Stan |
|-----------|------|------|
| `SidecarManager` | `sidecar.rs` | ✅ NOWY |
| CDAP config pola w `AgentConfig` | `config.rs` | ✅ |
| `to_sidecar_config()` helper | `config.rs` | ✅ |
| Sidecar komendy IPC (start/stop/restart/status) | `commands.rs` | ✅ |
| Auto-start sidecar po załadowaniu Tauri | `lib.rs` | ✅ |
| Tray "Restart CDAP agent" | `lib.rs` | ✅ |
| Komendy sidecar w `generate_handler!` | `lib.rs` | ✅ |

### 2.3 Co NIE działa (wymagane do pełnego remote)

| Obszar | Stan | Priorytet |
|--------|------|-----------|
| Go sidecar binary bundled w instalatorze | ❌ | **P0** |
| Screen capture ciągły (H.264 / VP8) | ❌ Go agent tylko 1 JPEG | **P0** |
| Input injection (mouse, keyboard) | ❌ Go agent stub | **P0** |
| Chat via serwer (WS) | ❌ tylko lokalny Vec | **P1** |
| Audio streaming | ❌ | **P1** |
| TLS cert pinning | ❌ | **P1** |
| UI statusu sidecar w StatusPanel | ❌ brak | **P1** |
| Consent dialog przed sesją | ❌ brak | **P1** |
| Auto-update | ❌ | **P2** |
| Policy enforcement (USB/app/pliki) | ❌ | **P2** |
| E2E NaCl encryption (media) | ❌ | **P2** |

---

## 3. Plan faz wdrożenia

### Phase 55 — Sidecar Foundation ✅ COMPLETED (2026-04-21)

Zrealizowane w tej sesji:

1. **`sidecar.rs`** — kompletny manager:
   - `find_binary()` — szuka w `$BETTERDESK_AGENT_BIN`, katalogu exe, data dir, PATH
   - `write_go_config()` — zapisuje JSON kompatybilny z `betterdesk-agent/agent/config.go`
   - `spawn_process()` — uruchamia go agenta z `-config <path>`
   - `monitor_loop()` — tokio task, poll co 5s, exponential backoff (5s×2^n, max 5min)
   - `terminate_child()` — SIGTERM + 5s grace + force kill
   - `Clone` przez `Arc<Inner>` — bezpieczne dla wielu wątków

2. **`config.rs`** nowe pola:
   - `api_key` — klucz API do CDAP gateway
   - `cdap_port` (default 21122)
   - `allow_screen_capture`, `require_consent`, `allow_terminal`, `allow_file_browser`, `allow_clipboard`
   - `auto_start_sidecar` (default true)
   - `to_sidecar_config()` → `SidecarConfig`

3. **`commands.rs`** — 4 nowe komendy:
   - `get_sidecar_status` → `SidecarStatus { running, pid, restart_count, state, binary_path, cdap_url }`
   - `start_sidecar` — zatrzymuje poprzedni, pisze config, uruchamia
   - `stop_sidecar` — SIGTERM + cleanup
   - `restart_sidecar` — alias start
   - `restart_agent_service` — teraz deleguje do `start_sidecar` (nie zwraca Err "manually")
   - `AgentSettings` rozszerzony o nowe pola capability

4. **`lib.rs`** integracja:
   - `SidecarManager` w `AgentState`
   - Auto-start po boot jeśli `auto_start_sidecar && is_registered`
   - Tray: "Restart CDAP agent" → natychmiastowy restart sidecar

---

### Phase 56 — Sidecar Bundling & UI Status (następna sesja)

**Cel:** agent binary dostępny bez ręcznej instalacji; UI pokazuje stan połączenia.

#### 56.1 — Bundling Go binary

```
betterdesk-agent-client/
└── src-tauri/
    ├── build.rs           ← compile Go binary if CARGO_CFG_TARGET_OS matches
    └── binaries/
        ├── betterdesk-agent-x86_64-pc-windows-msvc.exe
        ├── betterdesk-agent-x86_64-unknown-linux-gnu
        └── betterdesk-agent-aarch64-apple-darwin
```

`build.rs` logika:
```rust
// If betterdesk-agent source available in parent workspace, compile it.
// Otherwise the binary must be placed manually / downloaded by installer.
fn main() {
    tauri_build::build();
    let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let bin_name = if target == "windows" {
        "betterdesk-agent.exe"
    } else {
        "betterdesk-agent"
    };
    let src = format!("../betterdesk-agent/{}", bin_name);
    let dst = format!("binaries/betterdesk-agent-{}-{}-{}",
        env!("CARGO_CFG_TARGET_ARCH"),
        env!("CARGO_CFG_TARGET_VENDOR"),
        env!("CARGO_CFG_TARGET_OS"));
    // copy if exists (graceful — sidecar still works from PATH)
}
```

Alternatywnie: ALL-IN-ONE skrypt `betterdesk.sh/ps1` kopiuje binarny plik obok `.exe` agenta Tauri.

#### 56.2 — StatusPanel — sekcja "Connection Status"

Nowa sekcja w `StatusPanel.tsx`:
```tsx
// Pobrać co 5s przez invoke("get_sidecar_status")
// Pokazać: status dot (green=running/orange=stopped/red=not_configured)
// Pokazać: CDAP URL, PID, restarts
// Przycisk: "Reconnect" → invoke("restart_sidecar")
```

#### 56.3 — SettingsPanel — nowe pola

- API Key field (hasło, typ password)
- CDAP Port field  
- Toggle switches: Allow screen capture, Allow terminal, Allow file browser, Allow clipboard, Require consent
- "Auto-start CDAP agent" toggle

---

### Phase 57 — Continuous Screen Capture in Go Agent (tydzień 2-3)

**Cel:** zamiast jednego JPEG per `desktop_start`, Go agent streamuje ciągły feed.

#### Strategia

Modyfikacja `betterdesk-agent/agent/`:
- `desktop.go` — nowy moduł capture loop
- Crate (via CGo lub exec): `screencapture`, `screenshot-rs` → PNG → JPEG → CDAP frame
- Lub: wywołanie systemowych narzędzi:
  - Linux: `ffmpeg -f x11grab` lub `scrot -` (stdout pipe)  
  - Windows: `ffmpeg -f gdigrab` lub Windows GDI `BitBlt`
  - macOS: `screencapture -t jpg -` lub `AVFoundation`
- Protokół: `desktop_frame` co ~33ms (30fps) z `format: "jpeg"`, `sequence_no`, `timestamp`

Serwerowe CDAP `desktop.go` już wspiera strumień klatek — tylko agent musi wysyłać kolejne.

```go
// agent/desktop.go (nowy plik w betterdesk-agent)
type DesktopStream struct {
    sessionID string
    stop      chan struct{}
    ticker    *time.Ticker
    agent     *Agent
}

func (s *DesktopStream) Run() {
    for {
        select {
        case <-s.stop:
            return
        case <-s.ticker.C:
            data, err := CaptureScreenshot()
            if err != nil { continue }
            s.agent.sendMessage("desktop_frame", map[string]any{
                "session_id": s.sessionID,
                "format":     "jpeg",
                "data":       base64.StdEncoding.EncodeToString(data),
                "timestamp":  time.Now().UnixMilli(),
            })
        }
    }
}
```

Pliki do zmiany:
- `betterdesk-agent/agent/agent.go` — `handleDesktopStart` uruchamia `DesktopStream`, `handleDesktopStop` go zatrzymuje
- `betterdesk-agent/agent/desktop.go` — nowy plik z `CaptureStream`

#### Zgoda użytkownika (consent dialog)

Gdy serwer wyśle `desktop_start`:
1. Go agent sprawdza `cfg.RequireConsent` (nowe pole)
2. Jeśli true: wysyła do Tauri przez stdout JSON `{"type":"consent_request","session_id":"..."}`
3. Tauri odczytuje stdout sidecar, emituje event Tauri `consent-request`
4. Frontend (SolidJS) pokazuje dialog: "Operator XYZ chce uzyskać dostęp do ekranu. Zezwól?"
5. Frontend invoke `start_sidecar` lub event → Go agent dostaje odpowiedź przez stdin

---

### Phase 58 — Input Injection in Go Agent (tydzień 3-4)

**Cel:** operator może kontrolować mysz i klawiaturę zdalnego urządzenia.

#### Go agent — nowe handlery

```go
// agent/input.go (nowy plik)

// handleKeyboardInput — naciskanie klawiszy
func (a *Agent) handleKeyboardInput(msg *Message) {
    var p struct {
        Key       string `json:"key"`    // "a", "Enter", "F1", etc.
        Modifiers []string `json:"modifiers"` // ["ctrl", "shift"]
        Type      string `json:"type"`   // "keydown" | "keyup" | "keypress"
        Unicode   string `json:"unicode,omitempty"` // Unicode char
    }
    _ = json.Unmarshal(msg.Payload, &p)
    injectKey(p) // platform-specific
}

// handleMouseInput — ruch, kliknięcia, scroll
func (a *Agent) handleMouseInput(msg *Message) {
    var p struct {
        X      int    `json:"x"`
        Y      int    `json:"y"`
        Button string `json:"button"` // "left"|"right"|"middle"|""
        Type   string `json:"type"`   // "move"|"down"|"up"|"scroll"
        DeltaY int    `json:"delta_y,omitempty"`
    }
    _ = json.Unmarshal(msg.Payload, &p)
    injectMouse(p)
}
```

#### Platform implementacje

| Platform | Biblioteka/Syscall |
|----------|--------------------|
| Linux (X11) | `XTest` via cgo: `XTestFakeKeyEvent`, `XTestFakeMotionEvent` |
| Linux (Wayland) | `ydotool` (external process) lub `uinput` device |
| Windows | `SendInput` (Win32 API) via `windows-sys` cgo |
| macOS | `CGEventPost` (Carbon) via cgo |

Pliki do stworzenia:
- `betterdesk-agent/agent/input.go` — dispatcher + high-level API
- `betterdesk-agent/agent/input_linux.go` — X11 + Wayland
- `betterdesk-agent/agent/input_windows.go` — SendInput
- `betterdesk-agent/agent/input_darwin.go` — CGEventPost

---

### Phase 59 — H.264 Encoding (tydzień 4-5)

**Cel:** zamiast JPEG (wysokie rozmiary, niski framerate), Go agent enkoduje H.264.

#### Opcje encodera

| Opcja | Pro | Con |
|-------|-----|-----|
| `x264` via CGo | najlepszy quality/bitrate | wymaga CGo + licencja |
| `ffmpeg -encode_cmd` | zero CGo, prosty | latencja fork |
| `openh264` via CGo | open source, niski overhead | gorszy quality |
| VP8 (`libvpx`) | WebRTC standard | większy overhead |

**Rekomendacja dla MVP:** JPEG stream z wyższym FPS (15-20 fps zamiast 1) przez
Phase 57. H.264 jako opcja Phase 59+ gdy JPEG jest stabilny.

**Protokół frame:**
```json
{
  "type": "desktop_frame",
  "payload": {
    "session_id": "uuid",
    "format": "h264",
    "data": "base64_nalu",
    "keyframe": true,
    "width": 1920,
    "height": 1080,
    "timestamp": 1714000000000
  }
}
```

---

### Phase 60 — Audio Streaming (tydzień 5-6)

Go agent:
- Capture: `beep` / `PortAudio` via CGo lub `ffmpeg -f alsa/dshow`
- Encode: Opus via `libopus` CGo lub zewnętrzny proces
- Wiadomość: `audio_frame` z payload `{codec, data, timestamp}`

---

### Phase 61 — E2E NaCl + Consent Protocol + TLS Pinning (tydzień 6+)

- **E2E NaCl**: `golang.org/x/crypto/nacl/box` — Go agent generuje X25519 keypair,
  wymiana przez CDAP `key_exchange`, serwer widzi tylko ciphertext
- **Consent**: Go agent → stdout JSON → Tauri event → SolidJS dialog → stdin ACK
- **TLS pinning**: `tls.Config.VerifyPeerCertificate` w Go agent + fingerprint z
  `registration.rs` zapisany w keyring

---

## 4. Instalacja sidecar (aktualna procedura bez bundlingu)

Do czasu Phase 56 (bundling) użytkownicy muszą zainstalować `betterdesk-agent`
ręcznie lub przez skrypty ALL-IN-ONE.

### Opcja A — ALL-IN-ONE skrypt

```bash
# Linux: skrypt instaluje betterdesk-agent do /opt/betterdesk/
sudo ./betterdesk.sh

# Po instalacji agent Tauri znajdzie binarny w PATH lub /opt/betterdesk/
```

### Opcja B — Ręczna instalacja

```bash
# Pobierz binarny plik (GitHub Releases)
wget https://github.com/UNITRONIX/BetterDesk/releases/latest/betterdesk-agent-linux-amd64
chmod +x betterdesk-agent-linux-amd64
sudo mv betterdesk-agent-linux-amd64 /usr/local/bin/betterdesk-agent

# Ustaw API key w Ustawieniach agenta Tauri
# Kliknij "Restart CDAP agent" w menu tray
```

### Opcja C — Zmienna środowiskowa (dev)

```bash
BETTERDESK_AGENT_BIN=/path/to/betterdesk-agent ./BetterDesk\ Agent
```

---

## 5. Testowanie

### Smoke test (po Phase 55)

```bash
# 1. Uruchom agenta w trybie debug
RUST_LOG=debug ./betterdesk-agent-client --console

# 2. Sprawdź czy sidecar się uruchomił (jeśli betterdesk-agent w PATH)
# Oczekiwane w logach:
# [sidecar] Using binary: /usr/local/bin/betterdesk-agent
# [sidecar] Spawned betterdesk-agent (pid=XXXX)

# 3. Sprawdź status przez IPC
# W DevTools:
await window.__TAURI__.core.invoke("get_sidecar_status")
# Oczekiwane: { running: true, pid: XXXX, restart_count: 0, state: "running", ... }
```

### Crash recovery test

```bash
# Kill sidecar ręcznie
kill -9 $(pidof betterdesk-agent)

# Po 5s Tauri powinien zrestartować sidecar
# Log: [sidecar] Process exited: ... Restarting in 5s (attempt #1)
```

### Tray test

1. Kliknij PPM na ikonę tray
2. Wybierz "Restart CDAP agent"  
3. Sprawdź log: `[tray] Sidecar restarted`

---

## 6. Decyzje projektowe

| Decyzja | Uzasadnienie |
|---------|-------------|
| Sidecar Go zamiast Rust | Go agent ma 3K LOC działającego kodu. Rewrite w Rust = 4-6 tyg. Sidecar = 1-2 dni. |
| `skipTaskbar: true` | Agent ma działać cicho — użytkownik widzi tylko ikonę tray |
| `visible: false` domyślnie | Okno pojawia się tylko na żądanie (klik tray, help request, pierwsza rejestracja) |
| Stdout/stdin IPC dla consent | Nie ma sensu dodawać osobnego WS serwera między Tauri a Go — stdout jest wystarczający |
| Exponential backoff (max 5min) | Zapobiega `thundering herd` przy masowej awarii serwera |
| `find_binary()` 4-etapowe przeszukiwanie | Działa bez bundlingu (dev), z bundlingiem (prod), i z systemową instalacją |
| `require_consent` per capability | Prywatność użytkownika — nie każde urządzenie potrzebuje pełnego remote |

---

## 7. Zależności — nowe (wymagane do Phase 57-60)

### betterdesk-agent (Go sidecar)

```
# Phase 57 — screen capture
# Linux (X11): cgo + Xlib (brak zewnętrznych dep)
# Linux (Wayland): execute ydotool lub /dev/uinput (kernel module)
# Windows: Windows GDI API (builtin w Go via windows-sys/syscall)
# macOS: CGo + Quartz (builtin)

# Phase 58 — input injection
# Linux X11: CGo + XTest (libXtst-dev)
# Windows: windows-sys (już w Cargo.lock dla Tauri, dla Go: syscall)
# macOS: CGo + CGEvent

# Phase 59 — H.264
go get github.com/gen2brain/x264-go   # wrapper x264 via CGo
# ALT: ffmpeg subprocess (prostsze, bez CGo)

# Phase 60 — Audio
go get github.com/gordonklaus/portaudio  # PortAudio CGo
go get github.com/hraban/opus          # Opus CGo
```

### betterdesk-agent-client (Tauri Rust) — Phase 56

```toml
# build.rs — kopiowanie binarka Go
# Brak nowych deps w Cargo.toml wymaganych dla sidecar.rs
# (używa std::process::Command + tokio + libc — już są)
```

---

*Ostatnia aktualizacja: 2026-04-21 przez GitHub Copilot (Phase 55: Sidecar Foundation — sidecar.rs, config.rs capabilities, commands.rs IPC, lib.rs auto-start + tray restart).*
