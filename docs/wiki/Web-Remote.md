# Web Remote Desktop

BetterDesk includes a browser-based remote desktop client accessible from the web console.

---

## Overview

The web remote client connects to RustDesk peers directly from the browser, with no client installation needed. It supports:

| Feature | HTTPS | HTTP |
|---------|-------|------|
| Video codec | VP9, H.264, AV1, VP8 (WebCodecs) | H.264 only (JMuxer fallback) |
| Max FPS | 60 fps | 30 fps |
| Audio | ✅ Opus | ✅ Opus |
| Keyboard | ✅ Full (incl. modifiers, F-keys) | ✅ Full |
| Mouse | ✅ Click, right-click, scroll, drag | ✅ Click, right-click, scroll, drag |
| Clipboard | ✅ Bidirectional | ✅ Bidirectional |
| Session recording | ✅ WebM VP9+Opus | ✅ WebM VP9+Opus |
| Monitor switching | ✅ | ✅ |
| Quality presets | ✅ 4 presets | ✅ 4 presets |

> **Note:** HTTPS is strongly recommended. WebCodecs API (VP9/AV1) is only available on secure origins. HTTP falls back to JMuxer (H.264 only) with lower performance.

---

## Connecting

### From the Devices Page

1. Click the kebab menu (⋮) on a device row
2. Select **Connect**
3. Enter the device password
4. The remote desktop opens in a new tab

### Direct URL

```
http://your-server:5000/remote?id=DEVICE_ID
```

---

## Controls

### Toolbar

The remote desktop toolbar appears at the top:

| Button | Function |
|--------|----------|
| **Quality** | Switch between Speed / Balanced / Quality / Best presets |
| **Monitor** | Select which monitor to view (shows resolution) |
| **Record** | Start/stop session recording (downloads WebM on stop) |
| **Fullscreen** | Toggle fullscreen mode |
| **Disconnect** | End the remote session |

### Keyboard Shortcuts

All standard keyboard shortcuts pass through to the remote machine, including:
- Modifier keys (Ctrl, Alt, Shift, Win/Meta)
- Function keys (F1-F12)
- Special keys (PrintScreen, Scroll Lock, Pause)
- Ctrl+Alt+Delete (when supported by the remote OS)

### Mouse Input

| Action | Encoding |
|--------|----------|
| Left click | `TYPE_DOWN \| (BUTTON_LEFT << 3)` |
| Right click | `TYPE_DOWN \| (BUTTON_RIGHT << 3)` |
| Middle click | `TYPE_DOWN \| (BUTTON_MIDDLE << 3)` |
| Scroll | `TYPE_WHEEL \| (direction << 3)` |
| Move | Position sent as coordinates relative to canvas |

---

## Quality Presets

| Preset | Image Quality | FPS | Use Case |
|--------|--------------|-----|----------|
| **Speed** | Low | 30 | Slow connections, basic tasks |
| **Balanced** | Balanced | 30 | General use |
| **Quality** | Best | 30 | Detail work, design, reading |
| **Best** | Best | 60 | High-bandwidth, professional use |

Quality changes take effect immediately via `Misc` message to the peer.

---

## Session Recording

Record sessions as WebM video (VP9 + Opus audio):

1. Click **Record** in the toolbar (circle icon turns red)
2. Perform your remote desktop tasks
3. Click **Record** again to stop
4. The recording downloads automatically as a `.webm` file

Recordings capture the canvas at 15 fps. Audio is included if active during the session.

---

## Monitor Switching

For multi-monitor setups:

1. Click the **Monitor** dropdown in the toolbar
2. Select the desired display
3. The view switches to the selected monitor
4. **Primary** indicator shows which monitor is the default

Each monitor shows its resolution (e.g., `Monitor 1 (1920×1080) ★`).

---

## Video Pipeline

### HTTPS (WebCodecs)

```
Peer → H.264/VP9/AV1 frames → WebSocket → WebCodecs VideoDecoder → Canvas
```

- Negotiates codec via `VideoDecoder.isConfigSupported()`
- Supports VP9 (preferred), H.264, AV1, VP8
- Hardware acceleration when available
- `video_received` ACK sent before decode for optimal pipeline

### HTTP (JMuxer Fallback)

```
Peer → H.264 frames → WebSocket → JMuxer → MSE → Video element → Canvas
```

- JMuxer converts raw H.264 NALUs to MP4 fragments
- MSE SourceBuffer trimmed at 2 seconds to prevent overflow
- Auto-seek when buffer latency exceeds 500ms
- Health check every 1000ms with stall recovery

### Stall Recovery

If no frames arrive for 5 seconds, the client automatically requests a `refreshVideo` keyframe from the peer to resume the stream.

---

## Technical Details

### Connection Flow

1. Client opens WebSocket to Node.js console (`/ws/remote/{id}`)
2. Console proxies through Go server relay
3. NaCl key exchange establishes encrypted channel
4. Login message sent with password, codec preferences, FPS
5. Peer responds with video/audio streams

### Browser Requirements

| Browser | WebCodecs | JMuxer | Status |
|---------|-----------|--------|--------|
| Chrome 94+ | ✅ | ✅ | Full support |
| Edge 94+ | ✅ | ✅ | Full support |
| Firefox 130+ | ✅ | ✅ | Full support |
| Safari 16.4+ | Partial | ✅ | H.264 only |

### Known Limitations

- JMuxer (HTTP) is limited to H.264 at ~30 fps
- FileTransfer is not supported in web remote (use RustDesk desktop client)
- Audio quality depends on network bandwidth
- Some keyboard shortcuts may be intercepted by the browser (e.g., Ctrl+W)

---

## See also

- [[Web Console|Web-Console]] — launching remote from Devices page
- [[MeshAgent]] — MeshCentral-compatible web remote transport
- [[Client Setup|Client-Setup]] — desktop client alternative
