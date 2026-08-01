# Desktop Clients

BetterDesk provides two Tauri v2 desktop applications and a headless Go agent for different use cases.

> [!WARNING]
> **The MGMT Client and Agent Client are in early alpha (v1.0.0-alpha) and are NOT production-ready.**
> They are under active development, may contain bugs, incomplete features, and breaking changes between versions.
> **Do not deploy these clients in production environments.** For production use, rely on the **Web Console** (Node.js) for administration and the **standard RustDesk client** for remote desktop connections. See the [[Alpha Software Notice]] page for full details.

| Component | Status | Production Use |
|-----------|--------|----------------|
| **Go Server** | ✅ Stable | ✅ Recommended |
| **Web Console (Node.js)** | ✅ Stable | ✅ Recommended |
| **MGMT Client (Tauri)** | ⚠️ Alpha | ❌ Do not use in production |
| **Agent Client (Tauri)** | ⚠️ Alpha | ❌ Do not use in production |
| **Native Agent (Go)** | ✅ Stable | ✅ OK for deployment |

---

## BetterDesk MGMT Client

> ⚠️ **Alpha — not production-ready.** See [[Alpha Software Notice]] for known limitations.

**Purpose:** Operator/Admin desktop application for managing devices and conducting remote sessions.

**Technology:** Tauri v2 + SolidJS frontend + Rust backend (~40K LOC, 25+ modules, 100+ IPC commands)

### Features

| Feature | Description |
|---------|-------------|
| **Operator login** | JWT-based auth with TOTP 2FA support |
| **Device list** | Live status, search, filter, group by tags |
| **Remote desktop** | H.264/VP9 video decode, multi-monitor, session recording |
| **Input forwarding** | Keyboard (40+ keys, F1-F12, modifiers), mouse, text |
| **File transfer** | Local file browser, drag-and-drop transfer |
| **Chat** | E2E encrypted operator ↔ end-user messaging |
| **Wake-on-LAN** | Send WOL packets to offline devices |
| **Server management** | Health, clients, operators, audit, API keys, config |
| **Notification center** | Real-time push with type filtering |
| **Help requests** | Inbox with accept & connect workflow |
| **Session history** | Audit trail of past connections |
| **Unattended access** | Configure device passwords and access schedules |
| **Activity tracking** | 500-entry ring buffer with action icons |
| **mDNS discovery** | LAN server discovery via multicast DNS |

### Installation

Download from the [Releases](https://github.com/UNITRONIX/BetterDesk/releases) page:

- **Windows (NSIS):** `BetterDesk_MGMT_1.0.0_x64-setup.exe`
- **Windows (MSI):** `BetterDesk_MGMT_1.0.0_x64_en-US.msi`

### Building from Source

```bash
cd betterdesk-mgmt
npm install
cd src-tauri
cargo tauri build
```

**Requirements:** Rust 1.70+, Node.js 22+, WebView2 (Windows), webkit2gtk (Linux)

### Configuration

On first launch, enter your BetterDesk server address. The client connects to:
- **Port 5000** — Web console (for operator login)
- **Port 21114** — Go server API (for device management)
- **Port 21117** — Relay server (for remote sessions)

---

## BetterDesk Agent Client

> ⚠️ **Alpha — not production-ready.** See [[Alpha Software Notice]] for known limitations.

**Purpose:** Lightweight endpoint agent installed on managed devices. Provides the end-user interface for help requests and remote assistance.

**Technology:** Tauri v2 + SolidJS frontend + Rust backend (4 modules, 17 IPC commands)

### Features

| Feature | Description |
|---------|-------------|
| **Setup wizard** | 5-step server onboarding with validation |
| **Device registration** | Machine UID-based device ID (`BD-{hash}`) |
| **System info** | Hostname, OS, CPU, RAM, disk collection |
| **Status panel** | Connection status, device ID, copy button |
| **Chat** | Operator ↔ end-user chat panel |
| **Help requests** | 4-state flow: compose → sending → sent → confirmed |
| **Settings** | Connection, privacy, general, about tabs |
| **Tray icon** | Minimize to system tray, show/quit menu |
| **Autostart** | Launch on system boot |
| **Single instance** | Windows mutex prevents duplicate processes |

### Installation

Download from the [Releases](https://github.com/UNITRONIX/BetterDesk/releases) page:

- **Windows (NSIS):** `BetterDesk_Agent_1.0.0_x64-setup.exe`

### Setup Flow

1. Install and launch the agent
2. Enter your BetterDesk server address
3. The agent validates:
   - Server availability
   - Protocol compatibility
   - Registration open
   - Certificate verification
4. Device registers via heartbeat API
5. System info syncs via sysinfo API
6. Device appears in the web console

### Building from Source

```bash
cd betterdesk-agent-client
npm install
cd src-tauri
cargo tauri build
```

---

## BetterDesk Native Agent (Go)

**Purpose:** Headless agent for servers, IoT devices, and headless systems. Implements the CDAP protocol for telemetry, remote commands, and file management.

**Technology:** Go binary (~750 LOC core, gopsutil for metrics)

### Features

| Feature | Description |
|---------|-------------|
| **CDAP WebSocket** | Connects to Go server on port 21122 |
| **System metrics** | CPU, memory, disk usage (1s sample rate) |
| **9 default widgets** | 3 gauges, 2 text, terminal, file browser, button, clipboard |
| **Terminal emulation** | PTY on Unix, cmd.exe on Windows |
| **File browser** | List, read, write, delete with path traversal protection |
| **Clipboard** | Cross-platform via OS commands (xclip/pbcopy/powershell) |
| **Screenshot** | Platform-specific capture (screencapture/import/scrot) |
| **Heartbeat** | Configurable interval (default 15s) |
| **Auto-reconnect** | Configurable delay (default 5s) |

### Installation

```bash
# Linux
cd betterdesk-agent
go build -o betterdesk-agent .
sudo ./install/install.sh

# Windows
cd betterdesk-agent
go build -o betterdesk-agent.exe .
.\install\install.ps1
```

### Configuration

Create `config.json`:

```json
{
  "server": "ws://your-server:21122/cdap",
  "auth_method": "api_key",
  "api_key": "your-cdap-api-key",
  "device_id": "",
  "device_name": "Production Server",
  "device_type": "os_agent",
  "tags": ["production", "linux"],
  "terminal": true,
  "file_browser": true,
  "clipboard": true,
  "screenshot": true,
  "file_root": "/",
  "heartbeat_sec": 15,
  "reconnect_sec": 5,
  "log_level": "info"
}
```

### CLI Flags

```bash
betterdesk-agent [flags]

  -server string     WebSocket server URL (overrides config)
  -auth string       Auth method: api_key, device_token, user_password
  -api-key string    API key for authentication
  -device-id string  Device ID (auto-generated if empty)
  -device-name string  Human-readable device name
  -device-type string  Device type (default "os_agent")
  -config string     Config file path (default "config.json")
  -terminal          Enable terminal access
  -file-browser      Enable file browser
  -clipboard         Enable clipboard access
  -screenshot        Enable screenshot capture
  -heartbeat int     Heartbeat interval in seconds (default 15)
  -reconnect int     Reconnect delay in seconds (default 5)
```

### Security

The native agent runs with hardened systemd settings:
- `ProtectSystem=strict` (read-only filesystem)
- `PrivateTmp=yes` (isolated /tmp)
- `NoNewPrivileges=yes` (no privilege escalation)

See [[CDAP]] for the full protocol specification and SDK documentation.

---

## Comparison

| Feature | MGMT Client | Agent Client | Native Agent |
|---------|-------------|--------------|--------------|
| **Purpose** | Admin/Operator | End User | Server/IoT |
| **UI** | Full desktop app | Minimal status panel | Headless (no UI) |
| **Platform** | Windows, Linux, macOS | Windows, Linux, macOS | Any (Go binary) |
| **Protocol** | REST API + Relay | REST API | CDAP WebSocket |
| **Remote Desktop** | ✅ H.264/VP9 | Receives connections | Via CDAP |
| **File Transfer** | ✅ Drag-and-drop | Via operator | ✅ File browser |
| **Chat** | ✅ Operator side | ✅ User side | ❌ |
| **Terminal** | ❌ | ❌ | ✅ PTY |
| **Metrics** | Views metrics | Reports metrics | Reports metrics |
| **Single Instance** | ✅ Mutex | ✅ Mutex | ✅ PID file |
| **Tray Icon** | ✅ | ✅ | ❌ |
| **Binary Size** | ~4 MB (MSI) | ~3 MB (NSIS) | ~10 MB (Go) |

---

## See also

- [[⚠️ Alpha Notice|Alpha-Software-Notice]] — MGMT/Agent limitations
- [[CDAP]] — Native Go agent protocol
- [[Web Console|Web-Console]] — recommended admin UI
