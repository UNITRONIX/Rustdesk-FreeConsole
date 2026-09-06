# Web Remote Client Unification Plan

> Status: Phase 1, 2.1, 3.1 (partial), 3.2, 3.3 (partial), 3.4, 3.5, 3.6, 3.8 deployed (2026-04-25). Remaining phases pending.
>
> Goal: merge the two browser remote desktop clients (`/remote/:id` RustDesk
> client + `/remote-cdap/:id` CDAP agent viewer) into a single unified UI that
> auto-detects the available transport, unlocks richer features when the
> device runs the BetterDesk CDAP agent, and forwards the full RustDesk
> feature set (mouse, keyboard, clipboard, audio, multi-monitor, file
> transfer, recording).

---

## Phase 1 — Tab-close auto-disconnect ✅ DONE (2026-04-25)

Both web clients now wire `pagehide` and `beforeunload` listeners that close
every active session immediately when the operator closes the tab, navigates
away, or the browser evicts the page from bfcache. Saves bandwidth + CPU on
the remote endpoint.

**Files changed**
- `web-nodejs/public/js/cdap-desktop.js` — `closeAllDesktops()` + lifecycle
  hooks.
- `web-nodejs/public/js/remote.js` — iterates `sessions` and calls
  `client.disconnect()`.

Server-side teardown chain was already correct: WS drop →
`api.handleCDAPDesktop` → `cdap.Gateway.EndDesktopSession` → `desktop_end`
forwarded to agent → `DesktopStreamer.Stop()`.

---

## Phase 2 — Single entry point + transport router

**Goal:** one URL (`/remote/:id`), one EJS shell, two pluggable transports.

### Architecture

```
remote.ejs (unified shell)
  ├── TransportRouter
  │     ├── probe: GET /api/peers/:id → { device_type, cdap_connected, online }
  │     ├── decision tree:
  │     │     • cdap_connected=true                  → CDAPTransport
  │     │     • device_type=os_agent && offline       → wait + RustDesk fallback
  │     │     • else                                  → RustDeskTransport
  │     └── unified event surface:
  │         videoFrame, cursorUpdate, clipboardUpdate, monitorList,
  │         audioFrame, fileMeta, terminalChunk, ready, end, error
  │
  ├── SessionView
  │     ├── toolbar (capability pills lit/dimmed by transport):
  │     │   🎥 Video • 🔊 Audio • 📋 Clipboard • 📁 Files
  │     │   • 🖥️ Multi-monitor • 💻 Terminal • 💬 Chat • 🔴 Record
  │     ├── canvas + overlay
  │     ├── side dock (only shown if transport supports it):
  │     │     • file transfer panel
  │     │     • terminal panel (CDAP only)
  │     │     • live metrics panel (CDAP only)
  │     │     • chat panel
  │     └── InputDispatcher: encodes mouse/kbd once, sends to active transport
  │
  └── lifecycle: pagehide / beforeunload → transport.end()
```

### PR breakdown

#### PR 2.1 — Single route ✅ DONE (2026-04-25)
- `routes/remote.routes.js`: `/remote/:id` is now the canonical entry. Probes
  `/api/peers/:id` once on the server, sets `transport='cdap'|'rd'`, attaches
  a `capabilities` object, and renders the matching template. `?transport=`
  query param overrides auto-detection. `/remote-cdap/:id` kept as a 302
  redirect for legacy bookmarks and the existing `devices.js` Connect button.
- Templates still split (`remote.ejs` vs `remote-cdap.ejs`); will be merged
  in PR 2.2 / 2.3.

#### PR 2.2 — Shared UI shell
- Extract toolbar / sidebar / status bar into `views/partials/remote-shell.ejs`.
- Move CSS into `web-nodejs/public/css/remote.css` (currently inline).
- Delete `views/remote-cdap.ejs` once the unified shell handles both flows.

#### PR 2.3 — Transport adapters
- `public/js/rdclient/transport-rd.js` — wraps existing rdclient `client.js`,
  emits unified events.
- `public/js/rdclient/transport-cdap.js` — wraps current `cdap-desktop.js`
  WebSocket loop, emits the same unified events.
- Both expose: `start()`, `end()`, `sendMouse()`, `sendKey()`,
  `sendClipboard()`, `requestKeyframe()`, `selectMonitor()`,
  `getCapabilities()`.

#### PR 2.4 — Input dispatcher
- Move mouse / keyboard encoding into `public/js/rdclient/input.js` (already
  the canonical source).
- Replace ad-hoc encoding inside `cdap-desktop.js` (`MOUSE_TYPE_*`,
  `MOUSE_BUTTON_*`) with calls into the shared dispatcher.
- Clipboard hook: `navigator.clipboard.readText/writeText` with
  `execCommand('copy')` fallback. Permission prompt handled once on
  session start.

#### PR 2.5 — Side panels (CDAP-only)
- Terminal panel: reuse `public/js/cdap-terminal.js`, dock as resizable
  right-hand panel, gated on `capabilities.terminal`.
- File browser panel: reuse `public/js/cdap-filebrowser.js`, drag-and-drop
  upload.
- Live metrics: small CPU/RAM/disk strip in the bottom toolbar from
  `cdap.deviceStateChanged` events.

#### PR 2.6 — Chat dock
- Reuse `public/js/chat.js` + `chatRelay`, mount as collapsible right-edge
  drawer. Available on every transport.

---

## Phase 3 — Full RustDesk feature parity for CDAP

When the unified shell is in place, the CDAP transport becomes the place to
add the small remaining gaps so it matches the RustDesk client byte-for-byte.

### 3.1 Keyboard map parity ✅ PARTIAL DONE (2026-04-25)
- `cdap-desktop.js::sendKeyEvent` now drops OS-level auto-repeat
  (`e.repeat`) and routes single non-ASCII / non-alphanumeric printable
  characters (á, €, @, etc.) through the `text` input path so the
  agent's OS-level layout handles them. Modifier-laden combinations
  (Ctrl/Alt/Meta) keep the legacy keyboard path because the agent must
  see modifier presses, not the resolved character.
- Pending: F13–F24, exotic media keys, dead-key composition, full
  RustDesk-equivalent modifier flag bit-mask (would land alongside
  PR 2.4 input dispatcher).

### 3.2 Virtual paste fallback ✅ DONE (2026-04-25)
- Operator toolbar button `#bd-remote-paste` in `remote-cdap.ejs`
  reads the browser clipboard via `navigator.clipboard.readText()`
  and types it into the remote session as a single `input_type:"text"`
  event. Public API: `CDAPDesktop.pasteFromClipboard(deviceId, widgetId)`
  + `CDAPDesktop.sendText(deviceId, widgetId, text)` for canned-text
  injection from future side panels.
- Used when the device side refuses incoming clipboard sync, when the
  page lacks `clipboard-write` permission to the remote, or when the
  operator wants to inject text that never touches the device's
  clipboard history.

### 3.3 Pointer Lock + Keyboard Lock ✅ PARTIAL DONE (2026-04-25)
- Fullscreen + Keyboard Lock implemented in `cdap-desktop.js::toggleFullscreen`.
  Captures `Escape`, `Tab`, `Meta`, `Alt`, `Ctrl`, `PrintScreen` via
  `navigator.keyboard.lock()` while in fullscreen. `setDisconnected`
  releases both fullscreen and the keyboard lock.
- Toolbar button `#bd-remote-fullscreen` in `remote-cdap.ejs` toggles the
  state and swaps the icon based on `document.fullscreenchange`.
- Pointer Lock NOT yet wired — the CDAP fast path encodes mouse coords
  as absolute canvas positions; pointer lock would require a separate
  relative-motion input pipeline. Tracked for a future phase together
  with PR 2.4 (input dispatcher).

### 3.4 Session recording ✅ DONE (2026-04-25)
- `cdap-desktop.js` exposes `startRecording`, `stopRecording`,
  `downloadRecording`, `isRecording` on `window.CDAPDesktop`. Captures
  the canvas at 15 fps via `captureStream`, encodes to WebM with VP9 +
  Opus when supported (graceful fallback to VP8 → default WebM).
- Toolbar `#bd-remote-record` button toggles between start/download.
  Recorder is auto-stopped when the session disconnects so abrupt
  closes still produce a downloadable blob (next click on Record).
- Output: `cdap_session_<deviceId>_<ISO>.webm` saved via blob URL.

### 3.5 Operator presence / dead-man switch ✅ DONE (2026-04-25)
- Browser sends `{type:'presence_ping'}` every 15s from
  `cdap-desktop.js::startPresencePing`.
- Server: `api/cdap_handlers.go::handleCDAPDesktop` wraps each
  `wsConn.Read` in a 30s `context.WithTimeout`. On `DeadlineExceeded` the
  session is ended with reason `"browser presence timeout"`. The
  `presence_ping` case is a no-op since the read itself resets the
  deadline.
- Catches operator OS crashes / abrupt power loss where `pagehide` does
  not fire. Avoids zombie agent capture.

### 3.6 Hi-DPI awareness ✅ DONE (2026-04-25)
- `cdap-desktop.js` init message now includes `device_pixel_ratio`,
  `client_css_width`, `client_css_height` so the agent can pick a capture
  resolution that matches the operator's effective display. Unknown
  fields are ignored by older agents.

### 3.7 H.264 / VP9 fast path
- Replace MJPEG stream with H.264 NALU stream when the agent has
  `openh264` / hardware codec available. Browser uses WebCodecs
  `VideoDecoder` (already present in rdclient `video.js`).
- Falls back to MJPEG binary fast path (Phase 0) for browsers without
  WebCodecs.

### 3.8 Audio forwarding ✅ DONE (2026-04-25)
- `cdap-audio` module is now loaded alongside `cdap-desktop` for the CDAP
  remote view (`pageScripts: ['cdap-desktop', 'cdap-audio']` in
  `views/remote-cdap.ejs`).
- Toolbar `#bd-remote-audio` button connects / disconnects a receive-only
  audio session via `CDAPAudio.open(deviceId, 'remote-audio', { direction: 'receive' })`.
  A hidden audio widget element (`#wval-remote-audio`) gives the module
  a place to render its status / level meter without polluting the
  remote viewer chrome.
- Push-to-talk (microphone) and volume slider deferred until PR 2.5
  (side panels) where the unified shell will host the audio panel.

### 3.9 File transfer drag-and-drop
- Drop files on canvas → `cdap-filebrowser.js` upload.
- Right-click "Send file" picker for the reverse direction.

### 3.10 Process list / kill
- Agent: extend `agent/system.go` to expose `process_list` + `process_kill`
  CDAP commands.
- Browser: small process panel inside the metrics dock.

---

## Acceptance order suggestions

| Goal                                            | Recommended PRs           |
|-------------------------------------------------|---------------------------|
| Fastest "everything works in CDAP like rdclient"| 2.3, 2.4, 3.1, 3.2        |
| Cleanest UI / less duplication                  | 2.1, 2.2, then 2.3        |
| Most operator value first                       | 2.6 (chat), 3.4 (record), 3.8 (audio) |

---

## File touch list (rough)

```
web-nodejs/
  routes/remote.routes.js                           PR 2.1
  views/remote.ejs                                  PR 2.2
  views/partials/remote-shell.ejs       (new)       PR 2.2
  views/remote-cdap.ejs                 (delete)    PR 2.2
  public/css/remote.css                 (new)       PR 2.2
  public/js/remote.js                               PR 2.3
  public/js/rdclient/transport-rd.js    (new)       PR 2.3
  public/js/rdclient/transport-cdap.js  (new)       PR 2.3
  public/js/rdclient/input.js                       PR 2.4 / 3.1
  public/js/cdap-desktop.js             (collapse)  PR 2.3
  public/js/cdap-terminal.js                        PR 2.5
  public/js/cdap-filebrowser.js                     PR 2.5
  public/js/cdap-audio.js                           PR 3.8
  public/js/chat.js                                 PR 2.6

betterdesk-server/
  api/cdap_handlers.go                              PR 3.1
  cdap/desktop.go                                   PR 3.5
  cdap/audio.go                                     PR 3.8

betterdesk-agent/
  agent/desktop.go                                  PR 3.7 (H.264)
  agent/system.go                                   PR 3.10
  agent/clipboard.go                                PR 3.2
```

---

*Last updated: 2026-04-25 — author: GitHub Copilot during BetterDesk session.*
