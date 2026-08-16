# BetterDesk Web Remote Client - Historical Phased Implementation Plan

> Provenance notice: this document predates the clean-room compatibility
> process. It is retained for product history, not as an implementation
> specification. New compatibility work must follow
> [`support-agent-provenance.md`](../important/support-agent-provenance.md)
> and a BetterDesk-owned, versioned wire specification.

> Browser-based remote desktop client integrated into the BetterDesk web panel.  
> Users click a device in the device list → connect and control it via the browser.

---

## Vision

A user logs into the BetterDesk web console, sees the device list, clicks **"Connect"** on any online device, and a full remote desktop session opens in the browser — with video, keyboard, mouse, clipboard, and audio — without installing any client software on the controller machine.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│              BetterDesk Web Console (Node.js)               │
│                                                            │
│  ┌──────────────────────┐   ┌───────────────────────────┐  │
│  │   Admin Panel (EJS)  │   │   Remote Viewer (Canvas)  │  │
│  │   - Device list      │   │   - Video rendering       │  │
│  │   - "Connect" button │──>│   - Keyboard/Mouse input  │  │
│  │   - Status/settings  │   │   - Audio playback        │  │
│  └──────────────────────┘   │   - Clipboard sync        │  │
│                              │   - Connection status     │  │
│                              └────────┬──────────────────┘  │
│                                       │                     │
│  ┌────────────────────────────────────┴──────────────────┐  │
│  │              Web Client Core (JavaScript)              │  │
│  │                                                        │  │
│  │  ┌─────────────┐ ┌──────────────┐ ┌───────────────┐  │  │
│  │  │ Protocol    │ │ Media        │ │ Input         │  │  │
│  │  │ (protobufjs)│ │ (WebCodecs)  │ │ (DOM Events)  │  │  │
│  │  │ + NaCl      │ │ + Opus       │ │ + PointerLock │  │  │
│  │  └──────┬──────┘ └──────┬───────┘ └──────┬────────┘  │  │
│  │         │               │                │            │  │
│  │  ┌──────┴───────────────┴────────────────┴─────────┐  │  │
│  │  │        Connection Manager (WebSocket)            │  │  │
│  │  └──────────────────────┬───────────────────────────┘  │  │
│  └─────────────────────────┼──────────────────────────────┘  │
└─────────────────────────────┼────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │ WebSocket     │               │ WebSocket
              ▼               │               ▼
        ┌──────────┐          │         ┌──────────┐
        │   hbbs   │          │         │   hbbr   │
        │  :21118  │          │         │  :21119  │
        │  (WS)    │          │         │  (WS)    │
        └──────────┘          │         └──────────┘
                              │               │
                              │               │ TCP
                              │               ▼
                              │         ┌──────────────┐
                              │         │  Controlled  │
                              │         │   Device     │
                              └────────>│  (RustDesk)  │
                                        └──────────────┘
```

---

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Protocol | `protobufjs` | Serialize/deserialize RustDesk protobuf messages |
| Transport | Native `WebSocket` API | Connect to hbbs (:21118) and hbbr (:21119) |
| Encryption | `tweetnacl-js` | NaCl box/secretbox compatible with RustDesk's sodiumoxide |
| Video | `WebCodecs` API | Hardware-accelerated VP9/H264/AV1 decoding |
| Audio | `opus-decoder` (npm) | Opus decoding in browser |
| Rendering | `<canvas>` + `OffscreenCanvas` | Low-latency video display + cursor overlay |
| Input | DOM `KeyboardEvent` + `PointerEvent` | Keyboard/mouse capture with Pointer Lock |
| Build | `esbuild` or `vite` | Fast bundling of client-side JS modules |
| Integration | Express.js routes + EJS templates | Embed viewer into BetterDesk panel |

---

## Phase 1: Protocol Foundation (Est. 8-12 days)

### Goal
Establish WebSocket communication with hbbs, implement protobuf serialization, and complete the rendezvous handshake through relay.

### Tasks

#### 1.1 Protobuf Generation
- [ ] Use the canonical BetterDesk-owned schema and reproducible generation
      pipeline; do not copy external source or generated artifacts.
- [ ] Set up `protobufjs` build pipeline (pbjs/pbts)
- [ ] Generate JavaScript message classes + TypeScript definitions
- [ ] Verify encoding/decoding against independently authored black-box test
      vectors

#### 1.2 WebSocket Connection Manager
- [ ] Create `ConnectionManager` class
- [ ] Connect to hbbs via `ws://host:21118`
- [ ] Implement `RendezvousMessage` send/receive
- [ ] Handle reconnection, keepalive, error states
- [ ] Support `wss://` for HTTPS deployments

#### 1.3 Rendezvous Handshake
- [ ] Send `PunchHoleRequest` with target peer ID
- [ ] Receive `PunchHoleResponse` (expect relay, browser cannot hole-punch)
- [ ] Extract relay server address from response
- [ ] Connect to hbbr via `ws://relay:21119`
- [ ] Send `RequestRelay` with UUID to complete relay setup

#### 1.4 Encryption Layer
- [ ] Implement NaCl key generation (`tweetnacl-js`)
- [ ] Handle `SignedId` verification (peer's signed ID)
- [ ] Send `PublicKey` message (asymmetric + symmetric keys)
- [ ] Implement `crypto_box` / `crypto_secretbox` for encrypted frames
- [ ] Verify encryption is byte-compatible with RustDesk's `sodiumoxide`

#### 1.5 Login Flow
- [ ] Receive `Hash(salt, challenge)` from controlled device
- [ ] Compute password hash: `sha256(sha256(password) + salt)`
- [ ] Send `LoginRequest` with hashed password, options, version
- [ ] Receive `LoginResponse(PeerInfo)` with display info, codec support

### Deliverable
A Node.js/browser module that can connect to a RustDesk device through hbbs/hbbr relay, complete encryption, and receive `PeerInfo` after login.

### Files
```
web-nodejs/
├── public/
│   └── js/
│       └── rdclient/           # Web remote client
│           ├── proto/           # Generated protobuf code
│           │   ├── message.js
│           │   └── rendezvous.js
│           ├── connection.js    # WebSocket connection manager
│           ├── crypto.js        # NaCl encryption layer
│           ├── protocol.js      # Rendezvous + login handshake
│           └── index.js         # Client entry point
├── protos/                     # Source .proto files
│   ├── message.proto
│   └── rendezvous.proto
```

---

## Phase 2: Video Viewer (Est. 10-15 days)

### Goal
Decode and render the remote desktop video stream in a `<canvas>` element.

### Tasks

#### 2.1 Video Decoder
- [ ] Parse `VideoFrame` protobuf messages
- [ ] Detect codec from message type (vp9s, h264s, av1s, vp8s)
- [ ] Create `VideoDecoder` (WebCodecs API) with appropriate codec config
- [ ] Handle `EncodedVideoFrames` — decode each frame individually
- [ ] Implement codec switching mid-stream (format change detection)
- [ ] Send `SupportedDecoding` in `OptionMessage` during login (prefer VP9 + H264)

#### 2.2 Canvas Renderer
- [ ] Create full-screen `<canvas>` element for remote display
- [ ] Render decoded `VideoFrame` to canvas via `drawImage()`
- [ ] Handle display scaling (fit-to-window, 1:1, custom)
- [ ] Support multi-display (select display from `PeerInfo.displays`)
- [ ] Implement cursor overlay using `CursorData` messages
- [ ] Render cursor position from `CursorPosition` messages

#### 2.3 Viewer UI (EJS Integration)
- [ ] Create `/remote/:deviceId` route in Express.js
- [ ] Create EJS template with canvas, toolbar, connection status
- [ ] Add "Connect" button to device list page
- [ ] Show connection progress (Connecting → Authenticating → Connected)
- [ ] Display remote device info (hostname, platform, resolution)
- [ ] Add "Disconnect" button and session timer

#### 2.4 Password Prompt
- [ ] Modal dialog for device password entry
- [ ] Support saving passwords in BetterDesk admin session (optional)
- [ ] Handle authentication errors gracefully

### Deliverable
A view-only remote desktop viewer embedded in the BetterDesk panel. User clicks "Connect" on a device, enters password, sees live remote screen.

### Files (additions)
```
web-nodejs/
├── public/
│   └── js/
│       └── rdclient/
│           ├── video.js         # WebCodecs video decoder
│           ├── renderer.js      # Canvas renderer + cursor overlay
│           └── viewer.js        # Viewer UI controller
├── views/
│   └── remote.ejs               # Remote viewer page template
├── routes/
│   └── remote.js                # /remote/:deviceId route
```

---

## Phase 3: Input Control (Est. 8-10 days)

### Goal
Enable keyboard and mouse control of the remote device from the browser.

### Tasks

#### 3.1 Mouse Input
- [ ] Capture `PointerEvent` on the canvas element
- [ ] Map canvas coordinates to remote display coordinates (accounting for scale)
- [ ] Construct `MouseEvent` protobuf: `mask = (button << 3) | event_type`
- [ ] Handle: click, double-click, right-click, middle-click, wheel scroll
- [ ] Implement Pointer Lock API for FPS-style mouse capture (optional toggle)

#### 3.2 Keyboard Input
- [ ] Capture `KeyboardEvent` (keydown, keyup) on document
- [ ] Map browser key codes to RustDesk `ControlKey` enum
- [ ] Support `KeyboardMode.Map` (scancode-based) for best compatibility
- [ ] Handle modifier keys (Ctrl, Alt, Shift, Meta/Win)
- [ ] Send `KeyEvent` protobuf messages
- [ ] Special key combos: Ctrl+Alt+Del, PrintScreen, Windows key
- [ ] Prevent browser default actions for captured keys

#### 3.3 Touch Input (Mobile)
- [ ] Detect touch device
- [ ] Map touch events to mouse events (tap = click, drag = move)
- [ ] Pinch-to-zoom for canvas scaling
- [ ] Virtual keyboard toggle for mobile

#### 3.4 Toolbar Integration
- [ ] Toggle between view-only and full control mode
- [ ] Ctrl+Alt+Del button
- [ ] Full-screen toggle
- [ ] Quality selector (Best/Balanced/Low bandwidth)
- [ ] FPS display
- [ ] Latency indicator

### Deliverable
Full remote control: user can operate the remote desktop via keyboard and mouse from the browser.

### Files (additions)
```
web-nodejs/
├── public/
│   └── js/
│       └── rdclient/
│           ├── input.js         # Mouse + keyboard input manager
│           ├── touch.js         # Touch/mobile input handler
│           └── toolbar.js       # Viewer toolbar controller
```

---

## Phase 4: Audio & Clipboard (Est. 5-8 days)

### Goal
Add audio playback and clipboard synchronization.

### Tasks

#### 4.1 Audio Playback
- [ ] Parse `AudioFormat` message (sample_rate, channels)
- [ ] Decode Opus frames from `AudioFrame.data` using `opus-decoder`
- [ ] Create `AudioContext` + `AudioWorklet` for low-latency playback
- [ ] Handle sample rate conversion if device rate differs
- [ ] Mono/stereo conversion
- [ ] Mute/unmute toggle in toolbar

#### 4.2 Clipboard Sync
- [ ] Read clipboard content via `navigator.clipboard.readText()` (requires HTTPS)
- [ ] Send `Clipboard` protobuf message on paste
- [ ] Receive `Clipboard` messages from remote → write to local clipboard
- [ ] Support text and image clipboard formats
- [ ] Handle permission prompts gracefully

### Deliverable
Complete remote session with video, audio, input, and clipboard — comparable to the native RustDesk client for basic use cases.

### Files (additions)
```
web-nodejs/
├── public/
│   └── js/
│       └── rdclient/
│           ├── audio.js         # Opus decoder + WebAudio playback
│           └── clipboard.js     # Clipboard sync manager
```

---

## Phase 5: Advanced Features (Est. 10-15 days)

### Goal
Polish the experience and add power-user features.

### Tasks

#### 5.1 File Transfer
- [ ] Implement `FileAction` / `FileResponse` protobuf handling
- [ ] Upload files: browser `File` API → chunked protobuf messages
- [ ] Download files: protobuf chunks → `Blob` → download link
- [ ] Progress bar, pause/resume, cancel
- [ ] Drag-and-drop upload onto remote viewer

#### 5.2 Session Management
- [ ] Connection history log (saved to BetterDesk DB)
- [ ] Recent connections list on dashboard
- [ ] Multiple simultaneous sessions (tabbed viewer)
- [ ] Session recording (optional, save VP9 stream to WebM)

#### 5.3 Quality & Performance
- [ ] Adaptive quality based on network conditions
- [ ] FPS control via `OptionMessage.custom_fps`
- [ ] Image quality selector (Best/Balanced/Low)
- [ ] Network stats display (bandwidth, packet loss estimate)
- [ ] WebWorker-based decoding for UI thread offloading

#### 5.4 Multi-Display Support
- [ ] Parse `PeerInfo.displays` array
- [ ] Display selector in toolbar
- [ ] Show all displays in grid view
- [ ] Switch between displays seamlessly

#### 5.5 Security Enhancements
- [ ] Permission controls (view only, full control, file transfer)
- [ ] Session timeout / auto-disconnect
- [ ] Audit log for remote connections
- [ ] Two-factor authentication for remote access

---

## Phase 0 (Prerequisite): hbbr WebSocket Support

### Problem
The current BetterDesk hbbr relay server uses **plain TCP** on port 21117. Browsers can only communicate via **WebSocket**. A WebSocket layer is needed on port 21119 for the relay.

### Options

| Option | Effort | Latency | Recommended |
|--------|--------|---------|-------------|
| **A: Modify hbbr source** | 5-8 days | Lowest | ✅ Best |
| **B: WebSocket-to-TCP proxy** | 1-2 days | +5ms | Quick start |
| **C: Node.js WS proxy** | 2-3 days | +5-10ms | Easiest |

### Option A: Modify hbbr (Recommended)

Add `tokio-tungstenite` WebSocket listener on port 21119 to `relay_server.rs`. The hbbs rendezvous server already does this — the pattern exists in the codebase.

```rust
// In relay_server.rs — add WebSocket listener alongside TCP
let ws_listener = TcpListener::bind(format!("0.0.0.0:{}", port + 2)).await?;
// Accept WS connections, wrap in WsSink/WsStream, relay to TCP peers
```

### Option B: Nginx WebSocket Proxy (Quick Start)

```nginx
# /etc/nginx/conf.d/hbbr-ws.conf
server {
    listen 21119;
    location / {
        proxy_pass http://127.0.0.1:21117;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

> **Note:** This is a simplified proxy — the actual implementation requires WebSocket frame unwrapping since hbbr expects raw TCP bytes, not WS frames. A proper binary WebSocket-to-TCP bridge is needed.

### Option C: Node.js WS-to-TCP Bridge

```javascript
// ws-relay-proxy.js — minimal Node.js WebSocket-to-TCP bridge
const WebSocket = require('ws');
const net = require('net');

const wss = new WebSocket.Server({ port: 21119 });

wss.on('connection', (ws) => {
    const tcp = net.connect(21117, '127.0.0.1');
    
    ws.on('message', (data) => tcp.write(data));
    tcp.on('data', (data) => ws.send(data));
    
    ws.on('close', () => tcp.destroy());
    tcp.on('close', () => ws.close());
    tcp.on('error', () => ws.close());
    ws.on('error', () => tcp.destroy());
});
```

### Recommendation

Start with **Option C** (Node.js proxy) for rapid prototyping in Phase 1. Once the web client works, implement **Option A** (modify hbbr source) for production — it eliminates the proxy overhead and is architecturally cleaner.

---

## Development Timeline

| Phase | Duration | Cumulative | Dependencies |
|-------|----------|------------|--------------|
| Phase 0 (hbbr WS) | 2-3 days | 2-3 days | None |
| Phase 1 (Protocol) | 8-12 days | 10-15 days | Phase 0 |
| Phase 2 (Video) | 10-15 days | 20-30 days | Phase 1 |
| Phase 3 (Input) | 8-10 days | 28-40 days | Phase 2 |
| Phase 4 (Audio/Clipboard) | 5-8 days | 33-48 days | Phase 3 |
| Phase 5 (Advanced) | 10-15 days | 43-63 days | Phase 4 |

**MVP (View + Control):** Phases 0-3 = ~28-40 working days  
**Full Feature:** All phases = ~43-63 working days

---

## File Structure (Final)

```
web-nodejs/
├── protos/                          # Source protobuf definitions
│   ├── message.proto
│   └── rendezvous.proto
├── public/
│   └── js/
│       └── rdclient/                # Web remote client (bundled)
│           ├── proto/               # Generated protobuf JS code
│           │   ├── message.js
│           │   └── rendezvous.js
│           ├── connection.js        # WebSocket manager
│           ├── crypto.js            # NaCl encryption
│           ├── protocol.js          # Rendezvous + login handshake
│           ├── video.js             # WebCodecs video decoder
│           ├── audio.js             # Opus audio decoder
│           ├── renderer.js          # Canvas renderer + cursor
│           ├── input.js             # Keyboard + mouse input
│           ├── touch.js             # Touch/mobile input
│           ├── clipboard.js         # Clipboard sync
│           ├── toolbar.js           # Viewer toolbar
│           ├── viewer.js            # Viewer UI controller
│           └── index.js             # Client API entry point
├── views/
│   └── remote.ejs                   # Remote viewer page
├── routes/
│   └── remote.js                    # /remote/:deviceId routes
├── ws-relay-proxy.js                # Phase 0 Node.js WS-TCP bridge
```

---

## Browser Compatibility

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| WebSocket | ✅ | ✅ | ✅ | ✅ |
| WebCodecs (VP9) | 94+ | 130+ | ❌ | 94+ |
| WebCodecs (H264) | 94+ | 130+ | 16.4+ | 94+ |
| WebCodecs (AV1) | 94+ | 130+ | ❌ | 94+ |
| Pointer Lock | ✅ | ✅ | ✅ | ✅ |
| Clipboard API | ✅ (HTTPS) | ✅ (HTTPS) | ✅ (HTTPS) | ✅ (HTTPS) |
| AudioWorklet | ✅ | ✅ | 14.5+ | ✅ |

**Minimum:** Chrome/Edge 94+, Firefox 130+  
**Recommended:** Latest Chrome/Edge for best WebCodecs performance

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| NaCl encryption mismatch | Blocker | Test with `tweetnacl-js` vs `sodiumoxide` early |
| WebCodecs not available | High | Fallback to `libvpx-wasm` (slower) or MSE |
| hbbr WS proxy adds latency | Medium | Move to native hbbr WS (Phase 0 Option A) |
| Protobuf version mismatch | High | Use the versioned BetterDesk compatibility schema and black-box vectors |
| Browser blocks clipboard | Low | Clipboard requires HTTPS — already implemented |
| H.265 not supported | Low | Negotiate VP9/H264 instead |

---

*Document version: 1.0 | Created: 2026-02-17*  
*Project: BetterDesk Console — github.com/UNITRONIX/Rustdesk-FreeConsole*
