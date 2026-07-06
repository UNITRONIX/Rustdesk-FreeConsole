# RDClient ↔ RustDesk feature parity audit

Date: 2026-04-25  
Scope: web-based remote desktop client at `web-nodejs/public/js/rdclient/` (5,449 LOC) compared to upstream RustDesk client.

## Summary

RDClient is the **browser viewer** that talks to a peer device through the BetterDesk relay using a RustDesk-compatible signal/relay protocol. It is **not** a full RustDesk port — it focuses on browser-feasible features. The native CDAP/bd-signal channel covers some gaps (services, processes, events, files, screenshot, terminal) but does not yet provide a continuous video pipeline.

Symbols below: ✅ working, ⚠️ partial / behind a feature flag, ❌ missing.

## Capability matrix

| Capability | RustDesk client | RDClient (web) | bd-signal / agent | Status |
|---|---|---|---|---|
| Video stream (H.264/VP9 hw-decode) | ✅ libyuv + native | ⚠️ WebCodecs when HTTPS, JMuxer fallback over HTTP | ❌ | partial |
| Video stream (AV1) | ✅ on capable peers | ⚠️ negotiated only when WebCodecs reports support | ❌ | partial |
| Audio stream (Opus) | ✅ | ⚠️ Opus via WebCodecs, raw-PCM fallback | ❌ (no audio in agent) | partial |
| Microphone capture (operator → peer) | ✅ | ❌ | ❌ | **missing** |
| Mouse input (move/buttons/wheel) | ✅ | ✅ | ❌ → being added (Phase 58) | partial |
| Keyboard input (modifiers, function keys) | ✅ | ✅ | ❌ → being added (Phase 58) | partial |
| Clipboard sync (text + image) | ✅ bidirectional | ✅ text only via WebSocket | ⚠️ text only via bd-signal `clipboard.*` (planned) | partial |
| File transfer (upload/download/resume) | ✅ | ⚠️ basic upload/download, no resume | ⚠️ `files.read` only (no write) | partial |
| Multi-monitor | ✅ | ✅ peer-side monitor select | ❌ | partial |
| Session recording (.mp4 / WebM) | ❌ in client | ✅ WebM via canvas.captureStream | ❌ | RDClient-only |
| Quality presets (speed/balanced/best) | ✅ | ✅ runtime switch | ❌ | partial |
| Screenshot (one-shot) | ✅ | ✅ button | ✅ via `screenshot.capture` | done |
| Connect via PIN / 2FA | ✅ | ✅ | n/a | done |
| Permissions prompt on peer | ✅ | n/a (operator-driven) | ❌ no consent UI yet | **gap** |
| TCP-over-WebSocket relay | ✅ | ✅ | n/a | done |
| Direct hole-punch | ✅ | ❌ (browser limitation) | ❌ | unattainable in browser |
| LAN discovery (mDNS) | ✅ | ❌ | ❌ | n/a in browser |
| Terminal (PTY) | ✅ in 1.3+ | ❌ | ⚠️ `terminal.execute` one-shot only (no PTY) | partial |
| Services / processes / event log inspection | ❌ | ❌ | ✅ via bd-signal | bd-signal exclusive |
| File browser (read-only) | ✅ | ✅ inside file transfer | ✅ via bd-signal `files.browse/read` | done |
| File write / move / rename | ✅ | ⚠️ upload only | ❌ | **gap** |
| Wake-on-LAN | ❌ | n/a | n/a | server-side feature |
| Auto-update | ✅ | n/a (browser) | ❌ | **gap (agent)** |
| TOTP / 2FA login | ✅ | ✅ | n/a | done |
| End-to-end encryption (NaCl) | ✅ | ✅ via crypto.js | ⚠️ token-only on bd-signal channel | partial |

## Concrete gaps and severity

| Severity | Item | Where to fix |
|---|---|---|
| **CRITICAL** | No remote-desktop pipeline through bd-signal — operators only get JPEG snapshots when the RustDesk relay is unavailable. | `betterdesk-agent-client/src-tauri/src/bd_signal.rs` + new `remote-cdap.ejs` |
| **HIGH** | No input injection in agent (mouse/keyboard) — agent is read-only. | `bd_signal.rs` (`input.mouse`, `input.key` handlers) + `enigo` crate |
| **HIGH** | No file write/delete/rename in agent. | `bd_signal.rs` add `files.write`, `files.delete`, `files.rename` |
| **HIGH** | RDClient over plain HTTP cannot use WebCodecs → falls back to JMuxer (single-codec H.264, no AV1, no hw decode). | Force HTTPS in deployment; documented in DEPLOY.md |
| **MEDIUM** | No bidirectional clipboard sync via bd-signal. | `bd_signal.rs` add `clipboard.get/set` |
| **MEDIUM** | Permission prompt on peer for unattended operator sessions. | Tauri agent UI + new bd-signal `consent.request` |
| **MEDIUM** | No auto-update mechanism in Tauri agent. | `tauri-plugin-updater` integration |
| **LOW** | No microphone forwarding from operator to peer. | RDClient `audio.js` capture path + protocol |
| **LOW** | No file-transfer resume after interruption. | RDClient `filetransfer.js` checkpoint state |

## Phase 58 deliverable (this iteration)

This iteration extends bd-signal so the JPEG-polling viewer (`/remote-cdap/:id`) becomes interactive:

- `input.mouse` handler — accepts `{x_rel, y_rel, button, action, wheel_dx, wheel_dy}` where coordinates are normalised 0..1 against the most recent screenshot, button∈{left,right,middle}, action∈{move,down,up,click,wheel}.
- `input.key` handler — accepts `{key, code, action, modifiers}` where action∈{down,up,press}, modifiers∈{ctrl,shift,alt,meta}.
- `input.text` handler — accepts `{text}` for safe Unicode typing.
- Extended `screenshot.capture` reply with `width` and `height` so viewer can compute exact pixel coords without JPEG parsing.
- Viewer extension: keyboard listener, mouse listener, focus & pointer-lock toggles. Throttled to ≤30 events/sec to keep the bd-signal channel responsive.

This does **not** replace the RustDesk relay-based pipeline — it provides a *fallback control path* when the relay is unavailable or for low-bandwidth environments where JPEG snapshots are sufficient (kiosk, low-FPS monitoring, single-shot administration).

## Phase 59+ (future, scoped)

| Phase | Goal | Estimated effort |
|---|---|---|
| 59 | Continuous JPEG streaming through bd-signal (push events from agent) | 1 day |
| 60 | H.264 capture + encode in agent (via `xcap` + `openh264`) → WebCodecs path | 1–2 weeks |
| 61 | Audio capture in agent → operator playback | 1 week |
| 62 | Microphone forwarding (operator → peer) | 3 days |
| 63 | File write / delete / rename in `bd_signal.rs` | 1 day |
| 64 | Bi-directional clipboard via bd-signal | 1 day |
| 65 | Consent / permission prompt on peer | 2 days |
| 66 | Auto-update via `tauri-plugin-updater` + signed releases | 3 days |
| 67 | RDClient: file-transfer resume + microphone capture | 1 week |

## References

- `web-nodejs/public/js/rdclient/client.js` — main browser client
- `web-nodejs/public/js/rdclient/protocol.js` — RustDesk protocol layer
- `betterdesk-agent-client/src-tauri/src/bd_signal.rs` — agent signal/control channel
- `betterdesk-agent-client/src-tauri/src/cdap_client.rs` — CDAP gateway client
- Upstream RustDesk: <https://github.com/rustdesk/rustdesk>

## RustDesk 1.4.8 alignment (2026-07-06)

Audit against upstream tag **1.4.8** (June 2026). No breaking wire-format changes vs our `message.proto` / `rendezvous.proto` baseline — proto fields `supported_encoding`, `selected_sid`, `windows_sessions`, and `PeerInfo.encoding` were already present locally.

| RustDesk 1.4.8 item | RdClient status | Files | Notes |
|---|---|---|---|
| Client version string | **Fixed** — `BetterDesk-Web/1.4.8` | `protocol.js` | Peers see current baseline |
| `Misc.supported_encoding` handshake | **Fixed** — advertise on session start; parse inbound | `protocol.js`, `client.js` | H265 ability now probed when WebCodecs available |
| `windows_sessions` / `selected_sid` | **Fixed** — parse + Actions menu UI | `client.js`, `remote.js`, `lang/*.json` | Session picker when peer reports ≥2 sessions |
| Monitor quick-switch toolbar (#15342) | **Fixed** — `.toolbar-monitor-strip` for 2–4 displays | `remote.ejs`, `remote.css`, `remote.js` | Dropdown kept for virtual displays / >4 monitors |
| View-only clipboard disabled (#15224) | **Fixed** — guards on send + inbound apply + sync | `client.js`, `remote.js` | Matches upstream behaviour |
| Pause key Windows (#15351) | **Fixed** — `Pause` → `0xE046`; Linux `Delete`≠`Pause` | `keyboard-scancode.js`, tests | |
| Privacy mode multi-monitor (#15321) | **Partial** — toggle via `togglePrivacyMode` | `client.js` | Peer-side 1.4.8 refactor; no display param in web client |
| Clipboard DIB alpha (#15296) | **Partial** — RGBA path via `ImageData` | `clipboard.js` | PNG inbound preferred; alpha preserved on canvas path |
| Windows ARM64 host | n/a | — | Native peer feature, not rdclient |
| Hole-punch / mDNS | n/a | — | Browser limitation |
| Microphone → peer | **Missing** | `audio.js` | Phase 67 |
| File transfer resume | **Missing** | `filetransfer.js` | Phase 67 |
| Terminal PTY | **Missing** | — | bd-signal one-shot only |

### Verify with RustDesk 1.4.8 peer

1. Panel update → open `/remote/:id` — notch toolbar attached to tab bar; hover shows fullscreen + expand.
2. Password overlay — remember checkbox aligned under password field.
3. Multi-monitor peer — numbered strip in expanded notch; dropdown for virtual displays.
4. Windows multi-session host — Actions → Windows sessions.
5. View-only — clipboard paste and auto-sync blocked.
6. HTTPS + WebCodecs — H265 negotiates when peer supports it.
