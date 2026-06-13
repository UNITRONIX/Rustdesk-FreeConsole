# BetterDesk Desktop Client — Architecture & Roadmap

> Independent remote desktop solution — no RustDesk code, no AGPLv3 restrictions.  
> Fully compatible with BetterDesk Go server.

---

## 1. Architecture Overview

```
┌───────────────────────┐        ┌─────────────────────────┐        ┌───────────────────────────┐
│  BetterDesk Viewer    │        │  BetterDesk Go Server   │        │  BetterDesk Agent         │
│  (Tauri Desktop App)  │        │  (Signal + Relay + API) │        │  (Tauri Service/Tray)     │
│                       │        │                         │        │                           │
│  ┌─────────────────┐  │        │  ┌─────────────────┐    │        │  ┌─────────────────────┐  │
│  │ Web UI (SolidJS)│  │        │  │ WebRTC Signaling│    │        │  │ Screen Capture      │  │
│  │ - Remote view   │  │        │  │ (Pion SFU/TURN) │    │        │  │ (DXGI/PipeWire/X11) │  │
│  │ - Device mgmt   │  │        │  ├─────────────────┤    │        │  ├─────────────────────┤  │
│  │ - File transfer │  │        │  │ Signal Server   │    │        │  │ Video Encoder       │  │
│  │ - Settings      │  │        │  │ (existing TCP/  │    │        │  │ (VP8/VP9/H264)      │  │
│  └────────┬────────┘  │        │  │  UDP/WS)        │    │        │  ├─────────────────────┤  │
│           │           │        │  ├─────────────────┤    │        │  │ Input Injector      │  │
│  ┌────────┴────────┐  │        │  │ REST API        │    │        │  │ (SendInput/uinput)  │  │
│  │ Rust Backend    │  │        │  │ (Device mgmt,   │    │        │  ├─────────────────────┤  │
│  │ - WebRTC peer   │  │◄──────►│  │  auth, RBAC)    │◄──►│        │  │ Audio Capture       │  │
│  │ - Clipboard     │  │  WS    │  ├─────────────────┤  WS│        │  │ (WASAPI/PulseAudio) │  │
│  │ - File I/O      │  │signaling  │ Web Panel       │signaling    │  ├─────────────────────┤  │
│  │ - Platform APIs │  │        │  │ (Node.js/EJS)   │    │        │  │ Rust Backend        │  │
│  └─────────────────┘  │        │  └─────────────────┘    │        │  │ - WebRTC peer       │  │
│                       │        │                         │        │  │ - Clipboard         │  │
│  WebRTC (DTLS/SRTP)   │◄═════════════════════════════════════════►│  │ - File I/O          │  │
│  P2P or via TURN      │  encrypted media stream (VP8/VP9/H264)   │  └─────────────────────┘  │
└───────────────────────┘        └─────────────────────────┘        └───────────────────────────┘
```

### Core Principles

1. **Zero RustDesk code** — all components written from scratch or using MIT/BSD libraries
2. **WebRTC-first** — leverages battle-tested NAT traversal, encryption, and media transport
3. **Enterprise-ready** — RBAC, audit logs, device policies, SSO integration
4. **Cross-platform** — Windows, Linux, macOS via Tauri (Rust + WebView)
5. **Backward compatible** — existing BetterDesk server protocol supported for device registration

---

## 2. Technology Stack

| Component | Technology | License | Purpose |
|-----------|-----------|---------|---------|
| **Server** | Go (existing) | MIT | Signal, relay, API, device management |
| **WebRTC (Server)** | [Pion](https://github.com/pion/webrtc) | MIT | TURN server, SFU, WebRTC signaling |
| **Desktop Shell** | [Tauri v2](https://tauri.app/) | MIT/Apache 2.0 | Cross-platform desktop app |
| **UI Framework** | [SolidJS](https://solidjs.com/) | MIT | Reactive UI with minimal overhead |
| **Screen Capture** | Custom Rust | AGPL-3.0 | DXGI (Win), PipeWire (Linux), CGDisplay (macOS) |
| **Video Codec** | WebCodecs API / libvpx | BSD | VP8/VP9 encode/decode in WebView |
| **Audio** | WebRTC audio | BSD | Opus codec, echo cancellation |
| **Input Injection** | Custom Rust | AGPL-3.0 | SendInput (Win), uinput (Linux), CGEvent (macOS) |
| **File Transfer** | WebRTC DataChannel | BSD | Encrypted P2P file transfer |
| **Clipboard** | Custom Rust | AGPL-3.0 | Platform clipboard APIs |
| **Node.js Panel** | Express.js (existing) | MIT | Web admin panel |

### Key Libraries (all MIT/BSD/Apache 2.0)

```toml
# Rust (Tauri backend)
[dependencies]
tauri = "2"
webrtc = "0.11"              # Pion's Rust WebRTC (via webrtc-rs, MIT)
scrap = "0.5"                # Screen capture (MIT) - or custom DXGI
enigo = "0.2"                # Cross-platform input simulation (MIT)
arboard = "3"                # Cross-platform clipboard (MIT/Apache 2.0)
tokio = "1"                  # Async runtime (MIT)
serde = "1"                  # Serialization (MIT/Apache 2.0)
```

---

## 3. Protocol Design

### 3.1 Signaling (WebSocket)

The viewer and agent connect to BetterDesk Go server via WebSocket for signaling.
Authentication uses the existing API key + device ID system.

```
Viewer                    Server                    Agent
  │                         │                         │
  │─── WS Connect ────────►│                         │
  │─── Auth(token) ────────►│                         │
  │                         │                         │
  │─── ConnectRequest ─────►│                         │
  │    (target_device_id)   │─── ConnectNotify ──────►│
  │                         │    (viewer_info)        │
  │                         │                         │
  │                         │◄── AcceptConnect ───────│
  │                         │    (or RejectConnect)   │
  │                         │                         │
  │◄── WebRTC SDP Offer ───│◄── SDP Offer ───────────│
  │─── SDP Answer ─────────►│─── SDP Answer ─────────►│
  │◄── ICE Candidates ─────│◄── ICE Candidates ──────│
  │─── ICE Candidates ─────►│─── ICE Candidates ─────►│
  │                         │                         │
  │◄════ WebRTC P2P (DTLS/SRTP) ════════════════════►│
  │     Video + Audio + Data Channels                 │
```

### 3.2 Media Channels (WebRTC)

| Channel | Type | Purpose |
|---------|------|---------|
| `video` | MediaStream (SRTP) | Screen capture stream (VP8/VP9/H264) |
| `audio` | MediaStream (SRTP) | System audio capture |
| `input` | DataChannel (SCTP) | Mouse, keyboard, touch events |
| `clipboard` | DataChannel (SCTP) | Clipboard sync (text, images, files) |
| `file` | DataChannel (SCTP) | File transfer with progress |
| `control` | DataChannel (SCTP) | Session control (quality, resolution, disconnect) |

### 3.3 Security Layers

1. **TLS 1.3** — WebSocket signaling encrypted
2. **DTLS 1.2+** — WebRTC data channel encryption (built-in)
3. **SRTP** — Media stream encryption (built-in)
4. **E2E Encryption** — Optional additional layer on DataChannels (NaCl secretbox)
5. **Device Authentication** — Mutual TLS or token-based device identity
6. **Session Tokens** — Short-lived, signed JWT for each connection
7. **RBAC** — Server-side role-based access control (admin/operator/viewer)
8. **Audit Log** — Every connection attempt logged with metadata

---

## 4. Development Phases

### Phase 1: Foundation (4-6 weeks)
**Goal: Basic screen sharing viewer → agent via WebRTC**

- [ ] WebRTC signaling endpoint in Go server (Pion TURN + signaling)
- [ ] Tauri app scaffolding (viewer + agent mode)
- [ ] Screen capture module (Windows DXGI first)
- [ ] WebRTC peer connection (video stream from agent → viewer)
- [ ] Basic input forwarding (mouse + keyboard via DataChannel)
- [ ] Simple connection UI (enter device ID → connect)

**Deliverable:** Working screen sharing between two BetterDesk clients on LAN/WAN.

### Phase 2: Enterprise Core (4-6 weeks)
**Goal: Production-ready with device management**

- [ ] Device registration and management in Go server API
- [ ] Authentication flow (API key + device certificate)
- [ ] Web panel integration (connect to device from browser)
- [ ] Address book and device groups
- [ ] Connection quality adaptation (bitrate, resolution, FPS)
- [ ] Audio streaming (system audio capture)
- [ ] Linux screen capture (PipeWire + X11 fallback)
- [ ] File transfer via DataChannel

### Phase 3: Security & Polish (3-4 weeks)
**Goal: Enterprise security compliance**

- [ ] End-to-end encryption layer on DataChannels
- [ ] RBAC enforcement (admin/operator/viewer roles)
- [ ] SSO integration (OIDC/SAML)
- [ ] Comprehensive audit logging
- [ ] Session recording (optional)
- [ ] 2FA for connections (existing TOTP system)
- [ ] Connection policies (time limits, allowed hours, IP restrictions)

### Phase 4: Advanced Features (ongoing)
**Goal: Feature parity and beyond**

- [ ] Multi-monitor support
- [ ] Clipboard sync (text + images + files)
- [ ] Remote printing
- [ ] Wake-on-LAN
- [ ] Unattended access with service mode
- [ ] macOS support
- [ ] Auto-update mechanism
- [ ] Branding/white-label configuration

---

## 5. Project Structure

```
betterdesk-client/
├── src-tauri/                    # Rust backend (Tauri)
│   ├── src/
│   │   ├── main.rs              # Tauri entry point
│   │   ├── capture/             # Screen capture modules
│   │   │   ├── mod.rs
│   │   │   ├── dxgi.rs          # Windows DXGI Desktop Duplication
│   │   │   ├── pipewire.rs      # Linux PipeWire
│   │   │   └── x11.rs           # Linux X11 fallback
│   │   ├── input/               # Input injection
│   │   │   ├── mod.rs
│   │   │   ├── windows.rs       # SendInput API
│   │   │   └── linux.rs         # uinput / XTest
│   │   ├── webrtc/              # WebRTC peer management
│   │   │   ├── mod.rs
│   │   │   ├── peer.rs          # Peer connection lifecycle
│   │   │   ├── signaling.rs     # WebSocket signaling client
│   │   │   └── channels.rs      # DataChannel management
│   │   ├── clipboard/           # Clipboard sync
│   │   ├── filetransfer/        # File transfer protocol
│   │   ├── auth/                # Authentication
│   │   └── config/              # Configuration management
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                          # Web UI (SolidJS)
│   ├── App.tsx
│   ├── pages/
│   │   ├── Connect.tsx          # Connection screen (enter ID)
│   │   ├── Remote.tsx           # Remote desktop view
│   │   ├── Devices.tsx          # Device management
│   │   ├── Settings.tsx         # App settings
│   │   └── FileTransfer.tsx     # File transfer UI
│   ├── components/
│   │   ├── RemoteCanvas.tsx     # WebRTC video renderer
│   │   ├── InputHandler.tsx     # Mouse/keyboard capture
│   │   ├── Toolbar.tsx          # Session toolbar
│   │   └── DeviceList.tsx       # Device list with status
│   ├── lib/
│   │   ├── webrtc.ts            # WebRTC client-side logic
│   │   ├── signaling.ts         # WebSocket signaling
│   │   ├── input.ts             # Input event serialization
│   │   └── api.ts               # BetterDesk API client
│   └── styles/
├── package.json
├── vite.config.ts
└── README.md
```

---

## 6. Server Extensions Required

The BetterDesk Go server needs these new endpoints for the desktop client:

### WebRTC Signaling API

```
WS /ws/signal                           # WebRTC signaling WebSocket
POST /api/v2/connect                    # Request connection to device
POST /api/v2/connect/:id/accept         # Accept incoming connection
POST /api/v2/connect/:id/reject         # Reject incoming connection
POST /api/v2/connect/:id/ice            # Exchange ICE candidates
```

### Device Management API (enterprise)

```
GET    /api/v2/devices                  # List all managed devices
GET    /api/v2/devices/:id              # Get device details
PUT    /api/v2/devices/:id              # Update device settings
DELETE /api/v2/devices/:id              # Remove device
POST   /api/v2/devices/:id/wake        # Wake-on-LAN
GET    /api/v2/devices/:id/sessions     # Connection history
POST   /api/v2/groups                   # Create device group
PUT    /api/v2/groups/:id               # Update group
GET    /api/v2/policies                 # List connection policies
POST   /api/v2/policies                 # Create policy
```

### TURN Server (embedded in Go server via Pion)

```
STUN/TURN on UDP :3478                  # ICE connectivity checks
TURN on TCP :3478                       # TCP fallback for restricted networks
TURN on TLS :5349                       # TLS TURN for enterprise firewalls
```

---

## 7. Licensing

All BetterDesk components use permissive licenses:

| Component | License | Commercial Use |
|-----------|---------|---------------|
| BetterDesk Server (Go) | AGPL-3.0 | ✅ Under copyleft terms |
| BetterDesk Client (Tauri) | AGPL-3.0 | ✅ Under copyleft terms |
| BetterDesk Web Panel | AGPL-3.0 | ✅ Under copyleft terms |
| Pion WebRTC (dependency) | MIT | ✅ No restrictions |
| Tauri (dependency) | MIT/Apache 2.0 | ✅ No restrictions |
| SolidJS (dependency) | MIT | ✅ No restrictions |
| webrtc-rs (dependency) | MIT | ✅ No restrictions |
| libvpx (dependency) | BSD | ✅ No restrictions |

**No GPL/AGPL/LGPL dependencies** — safe for proprietary commercial distribution.

---

## 8. Comparison with RustDesk

| Feature | RustDesk | BetterDesk (planned) |
|---------|----------|---------------------|
| License | AGPLv3 (copyleft) | AGPL-3.0 (copyleft) |
| Protocol | Custom TCP + NaCl | WebRTC (DTLS/SRTP) + custom signal |
| NAT Traversal | Custom hole-punching | ICE/STUN/TURN (industry standard) |
| Encryption | NaCl secretbox (custom) | DTLS/SRTP (standard) + E2E option |
| Video Codec | Custom scrap + VP9 | WebCodecs/libvpx (VP8/VP9/H264) |
| Web Client | Limited | Full-featured (same codebase as desktop) |
| Device Mgmt | Basic | Full enterprise (groups, policies, RBAC) |
| SSO | None | OIDC/SAML support |
| Audit | None | Comprehensive logging |
| Firewall Friendly | TCP only | TURN over TLS (works through corporate firewalls) |

---

*Created: 2026-02-24*  
*Author: BetterDesk Team*
