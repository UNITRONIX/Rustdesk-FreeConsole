# BetterDesk 3.0 — Implementation Roadmap

> **Created:** 2026-03-25
> **Status:** Planning phase — awaiting implementation approval
> **Vision:** BetterDesk evolves from a remote desktop tool into a full-scale device fleet management ecosystem, comparable to Windows Server domain services but cross-platform and open.

---

## Phase 0 — Immediate Bug Fixes & Code Cleanup ✅ COMPLETED

### 0.1 Chat — Tray Menu Opens Main Window Instead of Chat ✅
**Problem:** Clicking "Chat" in the tray context menu opens the default BetterDesk window first, then the user has to click Chat inside it.
- ✅ `tray.rs`: `on_menu_event` "chat" handler now opens the dedicated `chat` WebviewWindow directly via `app.get_webview_window("chat")`
- ✅ Falls back to `navigate_to(app, "/chat")` only if chat window is not found
- Chat WebSocket auto-connects on window open (handled by `ChatWindow.tsx` `onMount`)

### 0.2 Chat — Shows "Disconnected" ✅
**Problem:** Chat UI displays disconnected status after opening.
- ✅ Root cause: WebSocket URL used hardcoded `ws://` even when `console_url` is HTTPS
- ✅ Added `server_ws_scheme()` method to `Settings` — returns `wss` for HTTPS, `ws` otherwise
- ✅ `lib.rs`: Chat and Remote agent WS URLs now use dynamic scheme (`ws://` or `wss://`)
- ✅ Added `reconnect_chat` IPC command — stops current agent, rebuilds URL, starts new agent
- ✅ `ChatWindow.tsx`: Added reconnect button (refresh icon) visible when disconnected
- ✅ `chat-window.css`: Styled `.cw-reconnect-btn` with hover state
- Reconnect logic with exponential backoff already existed (3s → 60s cap)

### 0.3 Rust Compilation Warnings (betterdesk-client) ✅
All 10 warnings fixed:
- ✅ Removed unused import `Instant` from `bd_registration.rs`
- ✅ Removed unused label `'heartbeat` on loop
- ✅ Prefixed unused variables: `_mode_str` (collector.rs), `_active` (incoming.rs), `_device_id`/`_status_tx` (spawn_mgmt_ws)
- ✅ Added `#[allow(unused_assignments)]` on `bd_registration_loop` for intentional re-initialization pattern
- ✅ `cargo check`: 0 warnings, 0 errors

### 0.4 Go Compilation Warnings (betterdesk-server) ✅
- ✅ `go vet ./...` — clean, 0 issues
- ✅ `go build ./...` — clean, 0 warnings/errors

### 0.5 Dependency Audit ✅
- ✅ `npm audit --omit=dev` for web-nodejs: 0 vulnerabilities
- `cargo audit` for betterdesk-client: pending (requires cargo-audit installation)
- ✅ All compile-time dependencies verified clean

---

## Phase 1 — Organization & User Account System ✅ IMPLEMENTED

### 1.1 Data Model (Go Server — PostgreSQL + SQLite) ✅
**Implemented:**
- ✅ `db/database.go`: Added 7 new model structs (Organization, OrgUser, OrgDevice, OrgInvitation, OrgSetting + role constants)
- ✅ `db/database.go`: Extended Database interface with 17 new methods across 5 entity groups
- ✅ `db/sqlite.go`: Added 5 new CREATE TABLE statements to Migrate()
- ✅ `db/sqlite_org.go`: Full SQLite implementation (~380 lines) with all CRUD operations
- ✅ `db/postgres.go`: Added 5 new CREATE TABLE statements to Migrate()
- ✅ `db/postgres_org.go`: Full PostgreSQL implementation (~330 lines) with all CRUD operations

```sql
-- Organizations
CREATE TABLE organizations (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT UNIQUE NOT NULL,
    logo_url    TEXT DEFAULT '',
    settings    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Organization users
CREATE TABLE org_users (
    id              TEXT PRIMARY KEY,
    org_id          TEXT REFERENCES organizations(id),
    username        TEXT NOT NULL,
    display_name    TEXT DEFAULT '',
    email           TEXT DEFAULT '',
    password_hash   TEXT NOT NULL,
    role            TEXT DEFAULT 'user',  -- owner, admin, operator, user
    totp_secret     TEXT DEFAULT '',
    avatar_url      TEXT DEFAULT '',
    last_login      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(org_id, username)
);

-- Device-to-organization binding
CREATE TABLE org_devices (
    org_id          TEXT REFERENCES organizations(id),
    device_id       TEXT NOT NULL,
    assigned_user_id TEXT DEFAULT '',
    department      TEXT DEFAULT '',
    location        TEXT DEFAULT '',
    building        TEXT DEFAULT '',
    tags            TEXT DEFAULT '',
    PRIMARY KEY(org_id, device_id)
);

-- Invitations
CREATE TABLE org_invitations (
    id          TEXT PRIMARY KEY,
    org_id      TEXT REFERENCES organizations(id),
    token       TEXT UNIQUE NOT NULL,
    email       TEXT DEFAULT '',
    role        TEXT DEFAULT 'user',
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ
);

-- Organization-level settings (policies, mappings)
CREATE TABLE org_settings (
    org_id  TEXT REFERENCES organizations(id),
    key     TEXT NOT NULL,
    value   TEXT DEFAULT '',
    PRIMARY KEY(org_id, key)
);
```

**Roles:** `owner` → `admin` → `operator` → `user` (read-only)

### 1.2 REST API Endpoints (Go Server) ✅
**Implemented:**
- ✅ `api/org_handlers.go`: 18 HTTP handlers (~650 lines) for orgs, users, devices, invitations, settings, login
- ✅ `api/server.go`: 22 routes registered with proper role-based auth (admin, operator, public)
- ✅ `api/auth_handlers.go`: /api/org/login added to public endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/org` | Create organization |
| `GET` | `/api/org/{id}` | Get organization details |
| `PUT` | `/api/org/{id}` | Update organization |
| `DELETE` | `/api/org/{id}` | Delete organization |
| `GET` | `/api/org/{id}/users` | List org users |
| `POST` | `/api/org/{id}/users` | Add user to org |
| `PUT` | `/api/org/{id}/users/{uid}` | Update user |
| `DELETE` | `/api/org/{id}/users/{uid}` | Remove user |
| `POST` | `/api/org/{id}/invite` | Generate invitation link |
| `POST` | `/api/org/{id}/devices` | Assign device to org |
| `GET` | `/api/org/{id}/devices` | List org devices |
| `POST` | `/api/org/login` | User login (returns JWT) |
| `POST` | `/api/org/logout` | User logout |

### 1.3 Client-Side Login (BetterDesk Desktop) ✅
- ✅ Login screen: server address + username + password (or org invitation token) — `OrgLoginPanel.tsx`
- After login: automatic chat name setup from `display_name`
- Device automatically assigned to organization on first login
- Persistent session via secure token storage (Tauri keyring / OS credential manager)
- Token refresh mechanism (short-lived access + long-lived refresh)

### 1.4 Web Panel — Organization Management ✅
**Implemented:**
- ✅ `routes/organizations.routes.js`: 2 page routes + 15 API proxy routes to Go server
- ✅ `views/organizations.ejs`: List view with create/edit modal
- ✅ `views/organization-detail.ejs`: Detail view with Users/Devices/Invitations/Settings tabs
- ✅ `public/js/organizations.js`: List page logic with CRUD
- ✅ `public/js/organizationDetail.js`: Detail page with tab switching
- ✅ `public/css/organizations.css`: Cards, tabs, role badges, modals
- ✅ `views/partials/sidebar.ejs`: Organizations nav link added
- ✅ i18n keys added for EN, PL, ZH (25 keys each)
- New "Organizations" tab in the panel sidebar
- CRUD for organizations, users, invitations
- Device list filterable by organization
- Sorting/grouping: organization → building → department
- Bulk operations: assign 50 devices to org at once

### 1.5 Organization Discovery Protocol (Enhancement) ✅
- ✅ Client auto-discovers BetterDesk server on LAN via mDNS/DNS-SD (`_betterdesk._tcp`) — `discovery/mdns.rs`
- ✅ `discover_mdns_servers` IPC command with 10s browse timeout
- ✅ `DiscoveryPanel.tsx` runs both UDP broadcast + mDNS in parallel, merges/deduplicates results
- ✅ Source badge (UDP/mDNS/both) shown on each discovered server
- User sees: "BetterDesk server found: office.example.com — Join?" → login → done.
- Zero manual configuration for corporate deployments.

---

## Phase 2 — Chat 2.0 (Encrypted, Organization-Aware)

### 2.1 End-to-End Message Encryption
- Per-conversation AES-256-GCM key
- Key exchange via X25519 Diffie-Hellman between participants
- Server stores only encrypted ciphertexts (zero-knowledge)
- Forward secrecy: key rotation every 24h or every 1000 messages
- Key backup: encrypted key export for admin recovery

### 2.2 Chat Features
| Feature | Priority | Description |
|---------|----------|-------------|
| 1:1 conversations | 🔴 Critical | Operator ↔ user direct messaging |
| Organization groups | 🔴 Critical | Auto-created groups per org/department |
| Custom groups | 🟡 High | Operator-created groups with invite |
| File sharing | 🟡 High | Up to 50MB, encrypted, with preview |
| System messages | 🟡 High | Alert, restart pending, update available |
| Typing indicator | 🟢 Medium | Real-time "typing..." status |
| Read receipts | 🟢 Medium | Double-check marks |
| Online presence | 🟢 Medium | Green/yellow/red dots |
| Message search | 🟢 Medium | Full-text search across conversations |
| Push notifications | 🟢 Medium | Desktop notifications via OS APIs |
| Message reactions | 🔵 Low | Emoji reactions on messages |

### 2.3 Chat Window in Desktop Client
- Dedicated window (not embedded in main window)
- Minimize to tray with unread badge counter
- Compact overlay mode (attachable to screen edge)
- Keyboard shortcut: Ctrl+Shift+C to toggle chat

### 2.4 Quick Commands in Chat (Enhancement)
Operator sends command in chat: `/screenshot`, `/restart`, `/lock`, `/deploy script.bat`.
User sees: "Operator Jan Kowalski requests: Restart computer [Accept] [Reject] [Accept for 5 min]".
Combines communication with remote actions.

---

## Phase 3 — Web Remote Client (Full Functionality)

### 3.1 Fix Current Issues
- **0 FPS**: Diagnose — likely missing `video_received` ACK or MSE buffer issue. Check `video.js` decode pipeline, verify H264 NALUs arrive intact, check JMuxer vs WebCodecs path.
- **No cursor**: Cursor data from `CursorData` protobuf not rendered — verify `renderer.js` `updateCursor()` is called, check zstd decompression path.
- **No interaction**: Input events not reaching remote — debug WebSocket relay path in `input.js`, verify mouse mask encoding (`TYPE | (BUTTON << 3)`).

### 3.2 Features to Implement

| Feature | Priority | Description |
|---------|----------|-------------|
| Image scaling | 🔴 Critical | Fit-to-window, 1:1 pixel, custom zoom (50%-200%) |
| Monitor switching | 🔴 Critical | Dropdown with monitor list from `PeerInfo.displays` |
| Fullscreen mode | 🔴 Critical | F11 / button, exit with Esc |
| Clipboard sync | 🟡 High | Bidirectional text copy/paste via `navigator.clipboard` |
| File transfer | 🟡 High | Drag & drop + file browser panel |
| Special keys | 🟡 High | Ctrl+Alt+Del, Win key, PrintScreen |
| Image quality slider | 🟢 Medium | Balanced / Quality / Speed presets |
| Session recording | 🟢 Medium | WebM recording with timestamps |
| Audio forwarding | 🟢 Medium | Remote audio → local speaker via WebAudio |
| Multi-session tabs | 🟢 Medium | Multiple connections in browser tabs |
| Floating toolbar | 🟢 Medium | Collapsible toolbar overlay at top |
| Touch support | 🔵 Low | Tablet / mobile touch-to-mouse mapping |
| Whiteboard overlay | 🔵 Low | Draw annotations over remote screen |

### 3.3 Connection Mode — Attended vs Unattended
- **Unattended (instant):** Device password → full access (current behavior)
- **Attended (with confirmation):** Operator clicks "Connect" → user sees popup:
  ```
  ┌─────────────────────────────────────────────┐
  │  🔔 Remote Access Request                    │
  │                                               │
  │  Operator: Jan Kowalski (Helpdesk IT)         │
  │  Organization: ACME Corp                      │
  │  Reason: Software installation                │
  │                                               │
  │  [Accept]  [Accept 5min]  [Reject]           │
  └─────────────────────────────────────────────┘
  ```
- Configurable per-organization: `connection_policy: unattended | attended | ask_always`

### 3.4 Session Recording & Playback (Enhancement)
Every remote session recorded as lightweight event stream (not raw video).
Operator/admin can replay exactly what happened. Audit trail at keystroke + mouse + screen level.
Critical for compliance (GDPR, SOX, HIPAA).

---

## Phase 4 — Background Client & Security Hardening

### 4.1 Background Service Mode
- Client installs as Windows Service (NSSM/sc.exe) + GUI tray component
- Closing GUI does not stop service → device remains accessible for remote
- Full shutdown (service stop) requires administrator privileges
- Auto-start with system (via service, not startup folder)
- Linux: systemd service + tray applet
- macOS: launchd daemon + menu bar app

### 4.2 Locked Settings (Organization Policy)
- Client settings protected by organization admin password
- Configuration pushed from web panel → client receives and applies
- User CANNOT change: server address, device password, connection policies
- User CAN change: theme, language (if policy allows)
- Policy enforcement checked on every client startup

### 4.3 Encryption Matrix

| Connection | Method | Status |
|-----------|--------|--------|
| Client ↔ Signal Server | TLS (`--tls-signal`) | ✅ Done |
| Client ↔ Relay Server | TLS (`--tls-relay`) | ✅ Done |
| Client ↔ Client (P2P) | NaCl box (X25519 + XSalsa20) | ✅ Done |
| Console ↔ Go Server API | HTTP localhost | ⚠️ Add mTLS or Unix socket |
| Chat messages | AES-256-GCM E2E | 📋 Phase 2 |
| Config push | TLS + signed payload | 📋 This phase |
| File transfer | ChaCha20-Poly1305 stream | 📋 Phase 3 |

### 4.4 Device Attestation (Enhancement)
Client sends TPM-based attestation (Windows) or hardware fingerprint (serial, MAC, BIOS UUID) during registration. Server verifies it is a known device. Prevents device_id spoofing. Critical for fleet security.

---

## Phase 5 — Fleet Management (Domain-like)

### 5.1 Organization Policies (Pushed to Clients)
```json
{
    "connection_policy": "attended",
    "allow_file_transfer": true,
    "allow_clipboard": true,
    "allow_audio": false,
    "max_session_duration_min": 120,
    "require_2fa_for_unattended": true,
    "allowed_operators": ["admin", "helpdesk"],
    "auto_update": true,
    "auto_update_channel": "stable",
    "wallpaper_policy": "hide_during_session",
    "idle_lock_timeout_min": 15,
    "password_policy": {
        "min_length": 12,
        "require_special": true,
        "max_age_days": 90
    },
    "network_policy": {
        "allowed_relay_servers": ["relay1.example.com", "relay2.example.com"],
        "block_direct_p2p": false
    }
}
```

### 5.2 Resource Mapping
- **Printers:** Operator configures printer mappings per device/group. Agent applies via OS APIs (Windows: `Add-Printer`, Linux: `lpadmin`).
- **Network drives:** Mount network shares via script push. Support for credential pass-through.
- **Network config:** DNS, proxy, VPN profiles pushed to client.
- Web panel: dedicated UI for managing mappings per org/department/device.

### 5.3 Task Scheduler
- Operator creates task → assigns to device/group → sets schedule (cron-like)
- Task types: PowerShell/Bash script, restart, update, install MSI/DEB/RPM, file deploy, registry edit
- Execution status: `pending` → `running` → `success` / `failed`
- Output log returned to panel in real-time via WebSocket
- Retry policy: configurable (0-3 retries, with backoff)

### 5.4 Visual Task Builder Module

Canvas-based visual workflow editor in the web panel:

```
┌──────────┐    ┌──────────────┐    ┌─────────────┐    ┌──────────┐
│ 🔵 Trigger│───▶│ 🟡 Condition  │───▶│ 🟢 Action    │───▶│ 🔴 Result │
│ Schedule  │    │ OS=Windows   │    │ Run Script   │    │ Log+Alert│
│ Daily 2AM │    │ RAM < 4GB    │    │ cleanup.ps1  │    │ Email    │
└──────────┘    └──────────────┘    └─────────────┘    └──────────┘
```

**Node types:**
| Color | Type | Examples |
|-------|------|----------|
| 🔵 Blue | Trigger | Manual, Schedule (cron), Event (disk full, CPU>90%, user login) |
| 🟡 Yellow | Condition | OS check, RAM/CPU threshold, user logged in, time window |
| 🟢 Green | Action | Run script, install software, copy file, restart service, send message |
| 🔴 Red | Result | Log output, send alert, email notification, chain to next workflow |
| 🟣 Purple | Transform | Parse JSON, filter list, set variable, delay/wait |

**Features:**
- Drag & drop canvas with zoom/pan
- Connection lines between nodes (directional)
- Conditional branching (if/else paths)
- Loop support (retry N times, for-each device)
- Export/import as JSON workflow definitions
- Template library (pre-built common workflows)
- Execution history with per-node status visualization
- Dry-run mode (simulate without executing)

### 5.5 Software Inventory & Compliance (Enhancement)
Agent regularly scans installed software (Windows: registry, Linux: dpkg/rpm, macOS: brew/apps).
Web panel shows:
- Which devices have Chrome v120 (outdated!)
- Which devices lack antivirus
- Compliance score per organization (0-100%)
- Auto-remediation: "Update Chrome on all devices" → one click

---

## Phase 6 — Scaling (Proxy/Relay Servers)

### 6.1 Distributed Architecture

```
                        ┌──────────────────────┐
                        │    Master Server      │
                        │    (Go, central)      │
                        │    PostgreSQL          │
                        │    Web Console         │
                        └──────────┬───────────┘
                                   │ gRPC / WS Federation
                  ┌────────────────┼────────────────┐
                  │                │                │
           ┌──────▼──────┐  ┌─────▼──────┐  ┌─────▼──────┐
           │ Building A   │  │ Building B  │  │ Building C  │
           │ Relay Node   │  │ Relay Node  │  │ Relay Node  │
           │ (Go lite)    │  │ (Go lite)   │  │ (Go lite)   │
           │ SQLite cache │  │ SQLite cache│  │ SQLite cache│
           └──────┬──────┘  └─────┬──────┘  └─────┬──────┘
                  │                │                │
            100 devices      200 devices      200 devices
```

### 6.2 Relay Node (Go Lite Binary)
- Lightweight binary: relay + local signal cache only
- Registers with Master Server on startup
- Routes local traffic (same building) without leaving LAN
- Fallback to Master if target is in another building
- Health reporting to Master (CPU, RAM, bandwidth, connected devices count)
- Auto-discovery: relay nodes find each other via Master's registry
- Failover: if relay node goes down, devices auto-reconnect to Master or another relay

### 6.3 Capacity Planning

| Configuration | Registered Devices | Concurrent Remote Sessions | Notes |
|--------------|-------------------|--------------------------|-------|
| Single Go server (SQLite) | ~200 | ~30 | Development/small office |
| Single Go server (PostgreSQL) | ~500-1000 | ~50 | Medium business |
| Master + 3 Relay Nodes | ~5000 | ~150 (50 per relay) | Multi-building enterprise |
| Master + 10 Relay Nodes | ~20000 | ~500 | Large enterprise |

**Bottleneck:** Relay bandwidth. One relay ≈ 50 concurrent sessions @ 2Mbps = 100Mbps sustained.

### 6.4 Intelligent Relay Selection (Enhancement)
Client measures latency to each relay node. Server assigns optimal relay based on:
- Physical location (same building = local relay, lowest latency)
- Relay load (weighted round-robin load balancing)
- Available bandwidth
- If both devices on same LAN → direct P2P (hole punch), zero relay overhead
- Failover chain: local relay → nearest relay → master relay

---

## Phase 7 — Cross-Platform Support

### 7.1 Compatibility Matrix

| Platform | Desktop Client | Background Agent | Remote Target (controlled) | Status |
|----------|---------------|-----------------|---------------------------|--------|
| **Windows 10/11** | ✅ Tauri (ready) | ✅ NSSM service | ✅ DXGI capture + enigo | Production |
| **Linux x86_64** | ✅ Tauri | ✅ systemd service | ✅ X11 capture + enigo | Requires testing |
| **Linux ARM64** | ✅ Tauri | ✅ systemd service | ⚠️ X11/Wayland | Raspberry Pi |
| **macOS ARM** | ✅ Tauri | ⚠️ launchd | ⚠️ Screen Recording perm | Requires signing |
| **macOS x64** | ✅ Tauri | ⚠️ launchd | ⚠️ Screen Recording perm | Legacy Intel |
| **Android** | 📱 Tauri Mobile | ⚠️ Foreground service | ❌ Viewer only | Planned |
| **iOS** | 📱 Tauri Mobile | ❌ Apple restrictions | ❌ Viewer only | Limited |
| **Web Browser** | ✅ Browser (exists) | N/A | N/A | In development |
| **ChromeOS** | ✅ Web + PWA | ⚠️ Linux container | ⚠️ Crostini only | Experimental |

### 7.2 Platform Limitations
- **iOS:** Apple prohibits background screen capture and input injection. Viewer + chat only. Must be distributed via App Store (review process).
- **Android:** Screen capture requires `MediaProjection` API + user consent every time. Input injection requires `AccessibilityService` approval. Mark as "Viewer + limited control".
- **macOS:** Requires Screen Recording permission (System Preferences → Privacy). Agent must be signed with Apple Developer ID. Notarization required for distribution.
- **Linux Wayland:** Capture via PipeWire portal API. More restricted than X11. Some compositors may block programmatic input.

### 7.3 Unified Protocol Layer (Enhancement)
Single protobuf schema for all platforms with capability negotiation at connect:

```protobuf
message ClientCapabilities {
    bool can_capture_screen = 1;
    bool can_inject_input = 2;
    bool can_transfer_files = 3;
    bool can_capture_audio = 4;
    bool supports_clipboard = 5;
    repeated string supported_codecs = 6;  // ["h264", "vp9", "av1"]
    string platform = 7;                   // "windows", "linux", "macos", "android", "ios", "web"
    string arch = 8;                       // "x86_64", "arm64", "armv7"
    string client_version = 9;
    repeated string supported_features = 10; // ["file_transfer", "chat", "audio", "printer_mapping"]
}
```

Server adapts behavior based on capabilities — never sends unsupported commands to limited clients.

---

## Phase 8 — Security Hardening & Continuous Auditing

### 8.1 Automated Auditing Pipeline
- `cargo audit` + `npm audit` in CI/CD on every PR
- SAST: `semgrep` custom rules for Go + JavaScript
- Dependency bot (Dependabot or Renovate) for automatic PR creation
- Pentest checklist executed before every major release
- `gosec` for Go-specific security issues

### 8.2 Security Documentation
| File | Purpose |
|------|---------|
| `docs/security/AUDIT_LOG.md` | History of audits with dates, findings, and resolutions |
| `docs/security/THREAT_MODEL.md` | Threat model (STRIDE methodology) |
| `docs/security/ENCRYPTION_SPEC.md` | Encryption specification (algorithms, key management, rotation) |
| `.github/SECURITY.md` | Responsible disclosure policy |
| `docs/security/COMPLIANCE.md` | GDPR, SOX, HIPAA compliance notes |

### 8.3 Hardening Priorities
1. Mutual TLS between Console ↔ Go Server (replace plain HTTP localhost)
2. API key rotation mechanism (auto-rotate every 30 days, grace period)
3. Audit log tamper detection (HMAC chain — each entry signs the previous)
4. Session timeout policies (configurable per-organization)
5. IP allowlisting per organization
6. Certificate pinning in desktop client (prevent MITM on TLS)
7. Memory-safe credential handling (zeroize secrets after use)
8. CSP headers hardening for web console
9. Rate limiting review for all public endpoints
10. Automated vulnerability scanning in Docker images (Trivy)

---

## Phase 9 — Internationalization (Multi-Language Support)

### 9.1 Current State

**Node.js Web Console** — 9 languages via JSON i18n files:

| Code | Language | Status |
|------|----------|--------|
| `en` | English | ✅ Complete (reference) |
| `pl` | Polish | ✅ Complete |
| `zh` | Chinese (Simplified) | ✅ Complete |
| `de` | German | ✅ Added |
| `es` | Spanish | ✅ Added |
| `fr` | French | ✅ Added |
| `it` | Italian | ✅ Added |
| `nl` | Dutch | ✅ Added |
| `pt` | Portuguese | ✅ Added |

**BetterDesk Desktop Client** — `language` field exists in Settings struct but no i18n framework is implemented yet. All UI strings are hardcoded in English.

### 9.2 New Languages to Add (Both Console and Client)

| Code | Language | Region Priority | Notes |
|------|----------|----------------|-------|
| `ja` | Japanese | 🟡 High | Large IT market, enterprise demand |
| `ko` | Korean | 🟡 High | Growing tech sector |
| `ru` | Russian | 🟡 High | Large user base, CIS region |
| `uk` | Ukrainian | 🟢 Medium | Distinct from Russian |
| `tr` | Turkish | 🟢 Medium | Growing IT sector |
| `ar` | Arabic | 🟢 Medium | RTL layout support required |
| `hi` | Hindi | 🟢 Medium | Largest population, growing IT |
| `sv` | Swedish | 🔵 Low | Nordic region |
| `nb` | Norwegian (Bokmål) | 🔵 Low | Nordic region |
| `da` | Danish | 🔵 Low | Nordic region |
| `fi` | Finnish | 🔵 Low | Nordic region |
| `cs` | Czech | 🔵 Low | Central Europe |
| `hu` | Hungarian | 🔵 Low | Central Europe |
| `ro` | Romanian | 🔵 Low | Eastern Europe |
| `th` | Thai | 🔵 Low | Southeast Asia |
| `vi` | Vietnamese | 🔵 Low | Southeast Asia |
| `id` | Indonesian | 🔵 Low | Large population |

### 9.3 Desktop Client i18n Architecture

#### System Language Auto-Detection
```rust
// Rust-side: detect OS locale on startup
fn detect_system_locale() -> String {
    // Windows: GetUserDefaultLocaleName() → "en-US", "pl-PL", etc.
    // Linux:   $LANG / $LC_MESSAGES → "pl_PL.UTF-8"
    // macOS:   CFLocaleCopyCurrent() → "en_US"
    sys_locale::get_locale().unwrap_or("en".into())
}
```

#### Language Selection Flow
1. **First launch / installer:** Detect system locale → map to nearest supported language → apply
2. **NSIS installer:** Language selection page during installation (NSIS built-in multilingual support)
3. **Settings UI:** Language dropdown with flag icons → change takes effect immediately (no restart)
4. **Organization policy override:** If org policy sets `forced_language: "en"`, user cannot change it

#### Client-Side i18n Implementation
- JSON translation files bundled in Tauri app resources (`src/locales/en.json`, `src/locales/pl.json`, ...)
- TypeScript i18n module with `t('key')` function and fallback chain: `user_language → system_language → en`
- Plural forms support (e.g., "1 device" vs "5 devices" — critical for Slavic languages)
- Date/time/number formatting via `Intl` API (respects locale conventions)
- RTL layout support for Arabic (CSS `direction: rtl` + mirrored UI)

```typescript
// Frontend usage example
import { t, setLocale } from './i18n';

// Auto-detect on startup
const systemLocale = await invoke('get_system_locale');
setLocale(settings.language || systemLocale || 'en');

// Usage in components
statusText.textContent = t('connection.connected_to', { name: peerName });
// en: "Connected to Office-PC"
// pl: "Połączono z Office-PC"
// ja: "Office-PC に接続しました"
```

### 9.4 Node.js Console i18n Improvements
- **Key completeness audit:** Automated CI check that all `lang/*.json` files have 100% key coverage vs `en.json`
- **Missing key fallback:** If a key is missing in current locale, fall back to English (already implemented, but add console warning)
- **Contributor workflow:** `npm run i18n:check` script that reports missing/extra keys per language
- **Machine translation baseline:** Use initial machine translation for new languages, then mark for human review with `"__needs_review": true` flag
- **Dynamic loading:** Load language files on demand (not all at startup) to reduce memory for 20+ languages

### 9.5 NSIS Installer Multilingual Support
```nsi
; Languages supported in installer UI
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Polish"
!insertmacro MUI_LANGUAGE "German"
!insertmacro MUI_LANGUAGE "Spanish"
!insertmacro MUI_LANGUAGE "French"
!insertmacro MUI_LANGUAGE "Italian"
!insertmacro MUI_LANGUAGE "Dutch"
!insertmacro MUI_LANGUAGE "Portuguese"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro MUI_LANGUAGE "Russian"
```

Tauri NSIS config in `tauri.conf.json`:
```json
{
  "bundle": {
    "windows": {
      "nsis": {
        "languages": ["English", "Polish", "German", "Spanish", "French",
                      "Italian", "Dutch", "Portuguese", "SimpChinese",
                      "Japanese", "Korean", "Russian"],
        "displayLanguageSelector": true
      }
    }
  }
}
```

### 9.6 Translation Workflow for Contributors
1. Copy `web-nodejs/lang/en.json` → `web-nodejs/lang/{code}.json`
2. Copy `betterdesk-client/src/locales/en.json` → `betterdesk-client/src/locales/{code}.json`
3. Translate all values (keep keys in English)
4. Run `npm run i18n:check` to verify 100% coverage
5. Submit PR with both console + client translations
6. CI validates: no missing keys, valid JSON, no duplicate keys

---

## Phase 10 — Device Resource Control & Endpoint Management

Operators need granular control over hardware resources on managed devices — USB ports, optical drives, monitors, disks, and per-user resource quotas.

### 10.1 USB Port Control
- **Disable/enable USB storage** per device or organization policy (block flash drives, allow keyboards/mice)
- Windows: Group Policy + registry (`HKLM\SYSTEM\CurrentControlSet\Services\USBSTOR\Start`)
- Linux: `udevadm` rules pushed via agent (`SUBSYSTEM=="usb", ATTR{bInterfaceClass}=="08", ACTION=="add", RUN+="/bin/sh -c 'echo 0 > /sys$DEVPATH/authorized'"`)
- Whitelist mode: only allow specific USB vendor/product IDs
- Audit log: every USB device insertion/removal logged with timestamp + device serial

### 10.2 Optical Drive Control
- Disable/enable CD/DVD/Blu-ray drives
- Windows: registry `HKLM\SYSTEM\CurrentControlSet\Services\cdrom\Start = 4` (disabled)
- Linux: blacklist `sr_mod` kernel module or udev rule
- Use case: prevent data exfiltration via optical media in secure environments

### 10.3 Monitor Management (Selective)
- **Query monitors:** Agent reports connected monitors (model, resolution, refresh rate, EDID data)
- **Selective disable:** Operator can disable specific monitors on multi-monitor setups
- **Resolution enforcement:** Lock resolution to organization standard (e.g., 1920×1080 for all call center PCs)
- **Brightness/power control:** Set screen brightness, schedule monitor power-off after hours
- Windows: `SetDisplayConfig` API / `ChangeDisplaySettingsEx`
- Linux: `xrandr` / `swaymsg output` commands

### 10.4 Disk Access Control
- **Read-only mode:** Make specific drives read-only (prevent writes to D:\)
- **Disk quota:** Set per-user storage limits (Windows: `fsutil quota`, Linux: `setquota`)
- **Partition visibility:** Hide specific partitions from user (Windows: `diskpart remove letter`)
- **Encryption enforcement:** Verify BitLocker/LUKS status, trigger encryption if not active
- **Disk health monitoring:** S.M.A.R.T. data collection, predictive failure alerts

### 10.5 Per-User Resource Allocation
- **CPU limit:** Cap process CPU usage per user session (Windows: Job Objects, Linux: cgroups v2)
- **RAM limit:** Set memory ceiling per user (cgroups `memory.max`)
- **Network bandwidth:** Per-user bandwidth throttle (tc/NetLimiter)
- **Process whitelist/blacklist:** Allow only approved applications to run
- Web panel: visual resource allocation editor per user/device/group

### 10.6 Resource Control API (Go Server)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/devices/{id}/resources` | Get current resource state (USB, drives, monitors) |
| `POST` | `/api/devices/{id}/resources/usb` | Set USB policy (enabled/disabled/whitelist) |
| `POST` | `/api/devices/{id}/resources/optical` | Set optical drive policy |
| `POST` | `/api/devices/{id}/resources/monitors` | Set monitor configuration |
| `POST` | `/api/devices/{id}/resources/disks` | Set disk access policy |
| `POST` | `/api/devices/{id}/resources/quotas` | Set per-user resource quotas |
| `GET` | `/api/org/{id}/resource-policy` | Get organization-wide resource policy |
| `PUT` | `/api/org/{id}/resource-policy` | Update organization-wide resource policy |

### 10.7 Web Panel — Resource Control UI
- Device detail page: "Resources" tab with visual toggles for each hardware component
- Organization settings: default resource policy template
- Bulk operations: "Disable USB storage on all Finance department PCs"
- Compliance dashboard: percentage of devices matching resource policy

---

## Phase 11 — Desktop Widget Mode UI Overhaul

The current desktop widget mode reuses Node.js panel styles directly, causing layout issues, button duplication, and poor desktop integration. This phase delivers a purpose-built desktop widget experience.

### 11.1 Window Management Fixes (Critical) ✅
- ✅ **Windows overflowing taskbar:** `getDesktopArea()` now uses `visualViewport` for accurate bounds, respects `--desktop-safe-bottom` CSS variable for OS safe area.
- ✅ **Maximize overflow fix:** `clampAllWindows()` now re-clamps maximized windows on viewport resize instead of skipping them.
- ✅ **Drag/resize clamping:** All bounds calculations use `getDesktopArea()` instead of raw `window.innerWidth/Height`.
- ✅ **Snap zones:** Support Windows snap layouts (Win+Arrow) properly — half-screen, quarter-screen positions within WorkArea.
- ✅ **visualViewport listener:** Added `visualViewport.resize` event listener for more accurate OS-level resize detection.

### 11.2 Bottom Taskbar Redesign ✅
**Changes:**
- ✅ **Removed** start button (app launcher menu) — conflicts with system start menu
- ✅ **Removed** wallpaper button — moved to desktop right-click context menu
- ✅ **Added** desktop context menu with Wallpaper / Refresh / Exit Desktop actions
- ✅ **Auto-hide:** Taskbar slides down when no open windows in widgets mode, appears on hover
- ✅ **Kept:** minimized app icons (click to restore), system clock (single instance, right-aligned), exit desktop button
- Semi-transparent bar (already had glassmorphic CSS) with smooth transition animation

### 11.3 Button Audit & Deduplication ✅
Full audit of all interactive elements in desktop widget mode:

| Component | Issue | Fix |
|-----------|-------|-----|
| Bottom taskbar | Duplicated wallpaper picker button | ✅ Removed — moved to right-click context menu |
| Bottom taskbar | Duplicated clock widget | ✅ Keep single clock, right-aligned |
| Bottom taskbar | App launcher menu | ✅ Removed entirely — use desktop icons or hotkey |
| Window title bars | Inconsistent button sizes | ✅ Standardized: 32×32px close/min/max buttons, 18px icons |
| Window title bars | Missing minimize button on some windows | ✅ All windows have minimize/maximize/close |
| Desktop right-click | Missing context menu | ✅ Added: Change Wallpaper, Refresh, Exit Desktop |

- ✅ Title bar: frosted glass `backdrop-filter: blur(12px) saturate(150%)`, 42px height
- ✅ Window focus: subtle accent border highlight `rgba(88, 166, 255, 0.25)`
- ✅ `refreshAll()` method added to `DesktopWidgets` API for context menu integration

### 11.4 New Generation Window Design ✅
All desktop widget app windows now use a unified modern design:

```
┌─ Device Manager ──────────────────────────── [─] [□] [×] ─┐
│ ┌─ Toolbar ────────────────────────────────────────────┐   │
│ │  🔍 Search...              [Filter ▾] [Refresh]      │   │
│ └──────────────────────────────────────────────────────┘   │
│                                                            │
│   Content area with desktop-optimized layout               │
│   (wider margins, larger click targets, hover states)      │
│                                                            │
│ ┌─ Status Bar ────────────────────────────────────────┐   │
│ │  55 devices │ 4 online │ Last refresh: 12:45        │   │
│ └──────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

**Design principles:**
- ✅ **Desktop-native feel:** Drop shadows, rounded corners (10px), frosted glass effect on title bar
- ✅ **Larger touch/click targets:** 32×32px for all window control buttons
- ✅ **Typography:** 13px title text, system font stack
- **Dark/light theme:** Follow system theme preference, with manual override
- ✅ **Resizable windows:** All windows freely resizable with min-size constraints
- ✅ **Window memory:** Position + size saved to `localStorage` per app, restored on reopen

### 11.5 Wallpaper Picker Redesign ✅
**Implemented:**
- ✅ **Tabbed UI:** Images tab + Solid Colors tab with smooth tab switching
- ✅ **Solid color grid:** 20 predefined dark color swatches with active state and checkmark
- ✅ **Custom color picker:** HTML5 color input for any solid background
- ✅ **Fit mode selector:** Fill (cover), Fit (contain), Stretch (100% 100%), Center (auto) — applies immediately
- ✅ **applyWallpaper():** Supports `solid:#rrggbb` prefix for solid colors, crossfade animation for images
- ✅ **Persistence:** Fit mode saved to `localStorage` (`bd_widget_wallpaper_fit`)
- ✅ **i18n:** 8 new keys (`wp_images`, `wp_colors`, `wp_custom_color`, `wp_fit_style`, `wp_fill`, `wp_fit`, `wp_stretch`, `wp_center`) added to all 9 languages (EN, PL, ZH, DE, ES, FR, IT, NL, PT)
- ✅ **Auto-tab switch:** Opens on Colors tab when current wallpaper is a solid color

### 11.6 Desktop Widget CSS Architecture ✅
- ✅ Separate stylesheet: `desktop-widget-overrides.css` — loaded only in embed mode (iframe windows)
- ✅ Override web panel styles with desktop-optimized spacing, sizes, colors
- ✅ CSS custom properties for theme switching: `--dw-bg`, `--dw-text`, `--dw-accent`, `--dw-border`
- ✅ Hide web-panel-specific elements in embed mode: breadcrumbs, session bar, footer
- ✅ Compact mode for small windows via `@container` query
- ✅ Thin scrollbar styling for desktop windows

---

## Phase 12 — Documentation, CI/CD & Automated Releases

### 12.1 README Rebuild
- **Complete rewrite** of `README.md` for BetterDesk 3.0 identity
- Sections: Overview, Architecture diagram, Quick Start (Docker/bare-metal/Windows), Feature matrix, Screenshots, Contributing, License
- Badges: build status, latest release, Docker pulls, license, languages count
- Migration guide from 2.x → 3.0

### 12.2 CDAP Documentation
| Document | Description |
|----------|-------------|
| `docs/cdap/OVERVIEW.md` | CDAP architecture, message flow, capability model |
| `docs/cdap/PROTOCOL.md` | Full protocol specification (message types, payloads, sequencing) |
| `docs/cdap/AGENT_GUIDE.md` | How to build a custom CDAP agent (Go/Python/Node.js) |
| `docs/cdap/BRIDGE_GUIDE.md` | How to build a CDAP bridge for IoT/industrial protocols |
| `docs/cdap/API_REFERENCE.md` | REST API endpoints for CDAP management |

### 12.3 BetterDesk SDK Documentation
| Document | Description |
|----------|-------------|
| `docs/sdk/OVERVIEW.md` | SDK architecture, supported platforms, capabilities |
| `docs/sdk/PYTHON_SDK.md` | Python SDK reference (`betterdesk-cdap` package) |
| `docs/sdk/NODEJS_SDK.md` | Node.js SDK reference (`betterdesk-cdap` package) |
| `docs/sdk/EXAMPLES.md` | Real-world integration examples (Modbus, SNMP, REST) |
| `docs/sdk/STUDIO_GUIDE.md` | CDAP SDK Studio user guide (Phase 14) |

### 12.4 Pre-Release Validation Checklist
Before merging any feature branch to `main`:
1. `cargo build --release` — no errors, warnings reviewed
2. `go build ./...` + `go vet ./...` — clean
3. `npm audit --omit=dev` — 0 vulnerabilities
4. `npm run i18n:check` — all languages 100% coverage
5. Docker build succeeds (single-container + multi-container)
6. Integration tests pass (if available)
7. CHANGELOG.md updated
8. Documentation reflects new features

### 12.5 GitHub Actions — Automated Client Builds
```yaml
# .github/workflows/release-client.yml
name: Build & Release Desktop Client
on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      version:
        description: 'Version tag (e.g., v3.0.0)'

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions-rust-lang/setup-rust-toolchain@v1
      - run: cd betterdesk-client && pnpm install && pnpm tauri build
      - uses: actions/upload-artifact@v4
        with:
          name: betterdesk-windows-x64
          path: betterdesk-client/src-tauri/target/release/bundle/nsis/*.exe

  build-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev
      - run: cd betterdesk-client && pnpm install && pnpm tauri build
      - uses: actions/upload-artifact@v4
        with:
          name: betterdesk-linux-x64
          path: betterdesk-client/src-tauri/target/release/bundle/deb/*.deb

  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - run: cd betterdesk-client && pnpm install && pnpm tauri build
      - uses: actions/upload-artifact@v4
        with:
          name: betterdesk-macos
          path: betterdesk-client/src-tauri/target/release/bundle/dmg/*.dmg

  release:
    needs: [build-windows, build-linux, build-macos]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            betterdesk-windows-x64/*.exe
            betterdesk-linux-x64/*.deb
            betterdesk-macos/*.dmg
```

### 12.6 GitHub Actions — Automated Container Builds
Extend existing `.github/workflows/docker-publish.yml`:
- Trigger on tag push (`v*`) and main branch merge
- Build: `ghcr.io/unitronix/betterdesk-server`, `ghcr.io/unitronix/betterdesk-console`, `ghcr.io/unitronix/betterdesk` (all-in-one)
- Multi-arch: `linux/amd64` + `linux/arm64`
- Automatic SBOM generation for supply chain security
- Trivy vulnerability scan before publish

### 12.7 Go Server Binary Releases
- Cross-compile on tag push: `linux/amd64`, `linux/arm64`, `windows/amd64`
- SHA256 checksums file (`CHECKSUMS.sha256`)
- Attach to GitHub Release alongside desktop client installers

---

## Phase 13 — UI/UX Polish, Theming & Onboarding Tutorials

### 13.1 Interactive Onboarding Tutorials
The tutorial system exists in code but is non-functional. This phase activates and polishes it.

**Tutorial flow (first-time user):**
```
┌──────────────────────────────────────────────────────────┐
│  👋 Welcome to BetterDesk!                                │
│                                                          │
│  Let's get you started in 3 steps:                       │
│                                                          │
│  ① Connect your first device                             │
│  ② Explore the dashboard                                 │
│  ③ Try a remote session                                  │
│                                                          │
│  [Start Tour]              [Skip — I know what I'm doing]│
└──────────────────────────────────────────────────────────┘
```

**Implementation:**
- **Spotlight overlay:** Dim the entire page, highlight the target element with a bright cutout
- **Step-by-step tooltips:** Arrow-pointed tooltips anchored to UI elements ("Click here to add a device")
- **Progress indicator:** "Step 3 of 7" with progress bar
- **Contextual triggers:** Tutorial for specific features activates on first visit (e.g., first time opening Devices → mini-tour)
- **Tutorial icons:** Each tutorial section gets a unique icon in the help menu
- **Completion tracking:** Store completed tutorials in user profile, show checkmarks
- Library: [Shepherd.js](https://shepherdjs.dev/) or custom implementation using CSS `clip-path` spotlight

**Tutorials to create:**
| # | Tutorial | Trigger | Steps |
|---|----------|---------|-------|
| 1 | Welcome Tour | First login | 7 steps — sidebar, dashboard, devices, settings |
| 2 | Device Management | First visit to Devices | 5 steps — list, filter, detail, connect, actions |
| 3 | Remote Session | First remote connect | 4 steps — toolbar, controls, clipboard, disconnect |
| 4 | Organization Setup | Create first org | 6 steps — create, invite, assign devices, policies |
| 5 | Chat Basics | First chat open | 3 steps — contacts, send message, file share |
| 6 | CDAP Overview | First CDAP visit | 5 steps — devices, widgets, commands, terminal |
| 7 | Desktop Widget Mode | First desktop mode launch | 4 steps — taskbar, windows, wallpaper, apps |

### 13.2 Page Transition Animations
- **Route transitions:** Smooth fade + subtle slide (150ms ease-out) between pages
- **List animations:** Staggered fade-in for device list rows (50ms delay per item, max 10)
- **Card animations:** Scale-up on appear (0.95 → 1.0), subtle hover lift (translateY -2px)
- **Modal animations:** Backdrop fade + modal slide-up (200ms cubic-bezier)
- **Notification toasts:** Slide-in from right, auto-dismiss with shrinking progress bar
- **Loading states:** Skeleton screens (pulsing grey placeholders) instead of spinners
- CSS class: `.page-enter`, `.page-enter-active`, `.page-exit`, `.page-exit-active`
- Respect `prefers-reduced-motion` — disable animations for accessibility

### 13.3 Theming System Enhancement

**Node.js Console themes:**
| Theme | Description |
|-------|-------------|
| Dark (default) | Current dark theme — polish edges, fix contrast ratios |
| Light | Full light theme with WCAG AA contrast compliance |
| System Auto | Follow OS dark/light preference via `prefers-color-scheme` |
| High Contrast | WCAG AAA compliance, thick borders, no transparency |
| Custom (org) | Organization can push custom brand colors + logo |

**Desktop Widget themes:**
| Theme | Description |
|-------|-------------|
| Transparent | Frosted glass with system wallpaper showing through |
| Solid Dark | Opaque dark background, high contrast text |
| Solid Light | Opaque light background |
| Accent Color | User picks accent color, UI adapts (like Windows personalization) |

**Implementation:**
- CSS custom properties for all colors: `--bd-bg-primary`, `--bd-text-primary`, `--bd-accent`, etc.
- Theme JSON files: `themes/dark.json`, `themes/light.json`, `themes/high-contrast.json`
- Theme preview: live preview in settings before applying
- Organization branding: custom logo + 3 brand colors pushed via org policy

### 13.4 Welcome Screen (Dashboard Enhancement)
- **Personalized greeting:** "Good morning, Jan" with time-based greeting
- **Quick actions bar:** 4 most-used actions as large cards (Connect, Chat, Devices, Tasks)
- **Activity feed:** Last 10 actions across the system ("Jan connected to Office-PC 5 min ago")
- **Health overview:** System health at a glance (X devices online, Y alerts, Z pending tasks)
- **Tip of the day:** Rotating tips about features the user hasn't tried yet

---

## Phase 14 — CDAP SDK Studio

A visual development environment inside the web console for building CDAP integrations — an Unreal Engine Blueprints-inspired node editor tailored for device automation and IoT connectivity.

### 14.1 Studio Overview

```
┌─ CDAP SDK Studio ──────────────────────────────── [─] [□] [×] ─┐
│ ┌─ Toolbar ──────────────────────────────────────────────────┐  │
│ │  [New] [Open] [Save] [Run ▶] [Debug] [Deploy] │ Zoom: 100% │  │
│ └────────────────────────────────────────────────────────────┘  │
│ ┌─ Palette ─┐ ┌─ Canvas ─────────────────┐ ┌─ Inspector ────┐  │
│ │           │ │                           │ │                │  │
│ │ 📡 Sources│ │  [Modbus TCP]──┐          │ │ Node: Filter   │  │
│ │  Modbus   │ │               ├──[Filter] │ │ ────────────── │  │
│ │  SNMP     │ │  [SNMP Poll]──┘    │      │ │ Field: temp    │  │
│ │  REST     │ │                    ▼      │ │ Operator: >    │  │
│ │  MQTT     │ │              [Dashboard]  │ │ Value: 80      │  │
│ │           │ │                    │      │ │                │  │
│ │ 🔄 Process│ │                    ▼      │ │ Connections:   │  │
│ │  Filter   │ │               [Alert]     │ │  In: 2 nodes   │  │
│ │  Transform│ │                           │ │  Out: 1 node   │  │
│ │  Aggregate│ │                           │ │                │  │
│ │  Delay    │ │                           │ │ [Delete Node]  │  │
│ │           │ │                           │ │                │  │
│ │ 📊 Output │ │                           │ └────────────────┘  │
│ │  Widget   │ │                           │ ┌─ Console ──────┐  │
│ │  Alert    │ │                           │ │ > Connected     │  │
│ │  Log      │ │                           │ │ > Polling temp  │  │
│ │  API      │ │                           │ │ > Value: 82.5   │  │
│ └───────────┘ └───────────────────────────┘ └────────────────┘  │
│ ┌─ Status Bar ───────────────────────────────────────────────┐  │
│ │  Flow: temperature-monitor.json │ Nodes: 4 │ Status: Ready  │  │
│ └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 14.2 Node Types (Visual Blocks)

#### Source Nodes (Data Input)
| Node | Description | Config |
|------|-------------|--------|
| 🟦 Modbus TCP | Read Modbus registers | Host, port, unit ID, register address, data type |
| 🟦 Modbus RTU | Read serial Modbus | Serial port, baud, parity, slave ID, register |
| 🟦 SNMP Poll | Poll SNMP OIDs | Host, community/v3 creds, OID list, interval |
| 🟦 REST Poll | Poll HTTP/REST endpoint | URL, method, headers, auth, interval, JMESPath |
| 🟦 MQTT Subscribe | Listen to MQTT topic | Broker, topic, QoS, TLS |
| 🟦 Webhook Listen | Receive HTTP webhooks | Path, method filter, auth token |
| 🟦 Device Telemetry | BetterDesk agent metrics | Device ID, metric names |
| 🟦 Database Query | Poll SQL database | DSN, query, interval |
| 🟦 File Watch | Watch file changes | Path, pattern, events (create/modify/delete) |

#### Processing Nodes (Transform & Logic)
| Node | Description | Config |
|------|-------------|--------|
| 🟨 Filter | Pass/block based on condition | Field, operator (>, <, ==, contains), value |
| 🟨 Transform | Map/rename/calculate fields | Expression (e.g., `temp_c * 9/5 + 32`) |
| 🟨 Aggregate | Combine multiple inputs | Mode (avg, min, max, sum, count), window |
| 🟨 Delay | Hold data for N seconds | Duration, buffer size |
| 🟨 Debounce | Suppress rapid changes | Threshold, cooldown period |
| 🟨 Switch | Route to different paths | Conditions (if/else/else-if branches) |
| 🟨 Merge | Combine multiple streams | Join strategy (latest, all, zip) |
| 🟨 Script | Custom JavaScript/Python | Code editor with intellisense |

#### Output Nodes (Actions & Destinations)
| Node | Description | Config |
|------|-------------|--------|
| 🟩 Widget Update | Update CDAP dashboard widget | Widget ID, value mapping |
| 🟩 Alert | Trigger alert/notification | Severity, message template, recipients |
| 🟩 Command | Send command to device | Device ID, command type, payload |
| 🟩 Log | Write to audit log | Log level, message template |
| 🟩 REST Call | Call external API | URL, method, headers, body template |
| 🟩 MQTT Publish | Publish to MQTT topic | Broker, topic, payload template |
| 🟩 Database Write | Insert/update SQL | DSN, table, field mapping |
| 🟩 Email | Send email notification | SMTP config, to, subject, body template |
| 🟩 Modbus Write | Write Modbus register | Host, register, value mapping |

### 14.3 Canvas Interaction
- **Drag & drop** nodes from palette to canvas
- **Connect** nodes by dragging from output port (right) to input port (left)
- **Wire types:** Data wire (blue), control wire (orange), error wire (red)
- **Zoom:** Scroll wheel or pinch, range 25%-400%
- **Pan:** Middle-click drag or space+drag
- **Multi-select:** Box select or Shift+click, move/delete in bulk
- **Minimap:** Bottom-right corner thumbnail of entire flow
- **Snap to grid:** Optional alignment grid (16px)
- **Undo/redo:** Ctrl+Z / Ctrl+Y with full history stack
- **Copy/paste:** Ctrl+C/V for node groups (including wires)
- **Comments:** Sticky note blocks for documentation

### 14.4 Code Mode (Alternative to Visual)
For advanced users who prefer writing code:

```javascript
// CDAP SDK Studio — Code Mode
import { Source, Filter, Output, Flow } from 'betterdesk-cdap-studio';

const flow = new Flow('temperature-monitor');

// Sources
const modbus = flow.addSource('modbus-tcp', {
    host: '192.168.1.100',
    port: 502,
    registers: [{ address: 100, type: 'float32', name: 'temp' }],
    interval: 5000,
});

const snmp = flow.addSource('snmp-poll', {
    host: '192.168.1.200',
    oids: [{ oid: '1.3.6.1.2.1.1.3.0', name: 'uptime' }],
    interval: 10000,
});

// Processing
const highTemp = flow.addFilter('high-temp', {
    condition: (data) => data.temp > 80,
});

// Outputs
const alert = flow.addOutput('alert', {
    severity: 'warning',
    message: 'Temperature ${temp}°C exceeds threshold!',
});

// Wiring
modbus.connect(highTemp);
highTemp.connect(alert);

flow.deploy();
```

- **Split view:** Visual canvas on left, generated code on right (bidirectional sync)
- **Code editor:** Monaco editor (VS Code engine) with syntax highlighting, autocomplete, error markers
- **Language support:** JavaScript (primary), Python (via SDK), YAML (declarative flows)

### 14.5 Flow Execution & Debugging
- **Run button:** Execute flow in sandbox (isolated from production)
- **Debug mode:** Step-by-step execution, inspect data at each node
- **Live data overlay:** When running, each wire shows last value passing through
- **Breakpoints:** Click node to set breakpoint — execution pauses, inspector shows data
- **Error handling:** Red glow on failed nodes, error details in console panel
- **Performance metrics:** Execution time per node, messages/second throughput
- **Dry-run:** Simulate with mock data without connecting to real devices

### 14.6 Flow Management
- **Save/Load:** Flows stored as JSON in Go server database
- **Version history:** Git-like versioning — diff between flow versions
- **Deploy:** Push flow to production (runs on Go server as background worker)
- **Import/Export:** Share flows as `.bdflow` files (JSON-based)
- **Template library:** Pre-built flows for common scenarios:
  - Temperature monitoring with alerts
  - SNMP device health dashboard
  - REST API data aggregator
  - Modbus PLC control panel
  - File change detector with backup

### 14.7 Studio UI Quality Standards
- **Polished interface:** Professional-grade look — not a prototype feel
- **Responsive:** Works on 1366×768 minimum, optimized for 1920×1080+
- **Help integration:** `?` button on every node opens inline documentation
- **Keyboard shortcuts:** Full keyboard navigation (Tab between nodes, Enter to connect)
- **Accessibility:** Screen reader labels on all interactive elements, keyboard-only usable
- **Contextual help:** Hover any node type in palette → tooltip with description + example

### 14.8 CDAP & SDK Improvements (Prerequisites)
Before launching Studio, ensure CDAP/SDK coverage is complete:
- [ ] Audio bidirectional relay (browser ↔ device)
- [ ] File transfer via CDAP channel (large file streaming)
- [ ] Multi-device command broadcast (send command to N devices simultaneously)
- [ ] Flow execution engine in Go server (runs deployed Studio flows as goroutines)
- [ ] CDAP event subscriptions (device online/offline/alert triggers for Studio sources)
- [ ] SDK versioning and backward compatibility guarantees
- [ ] Rate limiting per flow (prevent runaway flows from overloading devices)

---

## Priority Summary

| Phase | Name | Estimated Time | Priority |
|-------|------|---------------|----------|
| **0** | Bug Fixes + Code Cleanup | 1-2 days | 🔴 Immediate |
| **1** | Organizations + User Accounts | 1-2 weeks | 🔴 Critical |
| **2** | Chat 2.0 (Encrypted) | 1 week | 🟡 High |
| **3** | Web Remote Client (Full) | 2 weeks | 🔴 Critical |
| **4** | Background Client + Security | 1 week | 🔴 Critical |
| **5** | Fleet Management | 2-3 weeks | 🟡 High |
| **6** | Distributed Scaling | 2 weeks | 🟢 Medium |
| **7** | Cross-Platform | 3-4 weeks | 🟢 Medium |
| **8** | Security Hardening | Ongoing | 🔴 Continuous |
| **9** | Internationalization | 1-2 weeks | 🟡 High |
| **10** | Device Resource Control | 1-2 weeks | 🟡 High |
| **11** | Desktop Widget UI Overhaul | 1-2 weeks | 🔴 Critical |
| **12** | Documentation, CI/CD & Releases | 1 week | 🔴 Critical |
| **13** | UI/UX Polish & Onboarding | 1-2 weeks | 🟡 High |
| **14** | CDAP SDK Studio | 3-4 weeks | 🟡 High |

**Total estimated timeline:** ~22-30 weeks for all phases (parallel work possible on independent phases).

---

## Additional Enhancement Ideas

| # | Idea | Phase | Description |
|---|------|-------|-------------|
| 1 | **Wake-on-LAN** | 6 | Operator wakes powered-off computer via relay node on same LAN |
| 2 | **Remote Print** | 5 | Print document from panel on printer connected to remote device |
| 3 | **Asset QR Codes** | 5 | Each device gets a QR code. Phone scan → opens device panel page |
| 4 | **Maintenance Windows** | 5 | "Every Saturday 22:00-06:00 = service window". Auto-restart, updates |
| 5 | **Dashboard KPIs** | 5 | Uptime SLA per org, avg operator response time, sessions/day graphs |
| 6 | **Plugin System** | 5 | Third-party plugins for visual task builder (JIRA, ServiceNow, Slack) |
| 7 | **Emergency Broadcast** | 2 | Send message to ALL device screens in org (security alert, evacuation) |
| 8 | **Geo Map View** | 6 | World map showing device locations by building/office |
| 9 | **Bandwidth Monitor** | 6 | Per-device network usage tracking and alerts |
| 10 | **Auto-Scaling Relay** | 6 | Spin up cloud relay nodes automatically when load exceeds threshold |
| 11 | **MQTT Broker Integration** | 14 | Built-in MQTT broker for IoT devices, bridged into CDAP SDK Studio |
| 12 | **Mobile Companion App** | 7 | Lightweight Tauri Mobile app: chat, alerts, quick connect, device status |
| 13 | **SSO/SAML Integration** | 1 | Organization SSO via SAML 2.0 / OpenID Connect for enterprise auth |
| 14 | **Offline Mode** | 5 | Agent queues tasks/metrics when server unreachable, syncs on reconnect |

---

## Long-Term Vision (v4.0)

BetterDesk as a Linux-native domain controller alternative:
- Deep OS integration via BetterDesk SDK/agent
- Group Policy equivalent for Linux (pushed via agent)
- User provisioning across fleet (create Linux users on 500 machines in one click)
- Centralized authentication (BetterDesk as identity provider, LDAP/SAML bridge)
- Package management across fleet (apt/dnf/pacman unified)
- Kernel-level integration for maximum security and performance

---

*Last updated: 2026-03-25 by GitHub Copilot — Phase 0 completed, Phases 1-14 defined*
