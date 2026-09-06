# BetterDesk Agent Client Finalization Plan — 2026-05-06

## Current Runtime Decision

The selected stable architecture is:

- Tauri remains the endpoint UI, tray, setup wizard, policy surface, notification layer, and consent broker.
- The bundled Go `betterdesk-agent` is the active CDAP and remote-session engine.
- The native Rust `CdapClient` remains available for lightweight telemetry/future migration work, but it is no longer the preferred runtime for remote desktop parity.

This path is lower risk for the final agent because `betterdesk-agent/agent/desktop*.go`, `input*.go`, monitor handling, Wayland capture support, consent handling, terminal, file browser, clipboard, heartbeat, and reconnect already exist in the Go agent codebase.

## Fixes Applied In This Pass

1. Window close no longer opens a sudo quit prompt. Closing the window hides the agent to tray, while explicit quit still goes through the guarded quit flow.
2. Linux SIGTERM/SIGINT handling was added so system shutdown or restart can terminate the agent cleanly without waiting for sudo UI.
3. CDAP start/stop/restart controls are now administrator-only at the IPC layer.
4. The Status page hides CDAP controls from non-admin users and shows a managed background-service hint instead.
5. The tray menu no longer exposes the CDAP restart action to non-admin users.
6. The registered agent posts a system notification after startup, reporting that the background agent is running and whether CDAP is connected/reconnecting.
7. Bottom navigation scaling was adjusted for high-DPI / high-system-scale displays using stable minimum heights, `100dvh`, safe-area padding, and responsive label sizing.
8. Tauri window controls are explicitly marked minimizable, maximizable, closable, and resizable in `tauri.conf.json`.
9. The managed Go sidecar was wired back into `AgentState` as the active CDAP runtime.
10. Sidecar config now passes `require_consent` into the Go agent JSON config.
11. Sidecar stdout consent reader now restarts after sidecar process recovery, preserving supervised-session prompts after crashes/restarts.
12. Sidecar binary discovery now supports Tauri externalBin target-triple filenames such as `betterdesk-agent-x86_64-unknown-linux-gnu`.
13. Unregister and explicit quit now stop both the Go sidecar and the native Rust CDAP client to avoid stale background connections.

## Final Agent Requirements

The final BetterDesk Client Agent must support:

- Supervised access: user consent prompt before a session if policy requires it.
- Unattended access: policy-controlled connection without user consent when explicitly enabled.
- RDClient feature parity: high-resolution streaming, remote input, clipboard sync, file transfer, monitor selection, quality presets, reconnect, and audit events.
- RustDesk desktop client compatibility where protocol boundaries allow it.
- Linux X11 and Wayland, Windows, macOS, and later Android.
- Hardware-accelerated codecs where available, with safe software fallback.
- Background resilience after reboot, including autostart, CDAP reconnect, heartbeat, sysinfo refresh, and operator-visible status.
- User tamper resistance: regular users must not be able to stop CDAP, unregister the device, or disable critical modules.

## Recommended Implementation Path

### Phase A — Stabilize One Real Remote Runtime

Status: started. The Go sidecar is now the selected runtime for CDAP and remote-session work.

Remaining work:

- Validate the packaged sidecar path on Windows, Linux, and macOS installers.
- Make sidecar health and reconnect status visible in the Status page.
- Add structured sidecar logs to diagnostics.
- Confirm no duplicate device sessions are created when heartbeat, bd-signal, and sidecar run together.

### Phase B — Supervised/Unattended Policy Contract

Add explicit policy fields from server to agent:

- `allow_remote_desktop`
- `require_consent`
- `allow_unattended`
- `allowed_operators`
- `session_recording_policy`
- `max_resolution`
- `max_fps`
- `codec_policy`

The agent must enforce policy locally, not only in the web console.

### Phase C — Remote Desktop Capability Matrix

Linux:

- X11: x11grab or native capture backend, xdotool/enigo input.
- Wayland: xdg-desktop-portal + PipeWire capture, compositor-safe input path via ydotool/ydotoold or portal-backed remote desktop where available.
- GPU: VAAPI / NVENC / AMF detection through ffmpeg capability probing.

Windows:

- Capture: DXGI Desktop Duplication or Windows Graphics Capture.
- Input: SendInput.
- GPU: Media Foundation / D3D11 / NVENC / AMF where available.

macOS:

- Capture: ScreenCaptureKit on modern macOS, AVFoundation fallback.
- Input: CGEvent with Accessibility permission.
- GPU: VideoToolbox H.264/HEVC.

Android later:

- Capture: MediaProjection.
- Input: Accessibility service or enterprise device-owner mode.
- Transport: CDAP-compatible mobile channel with Android lifecycle constraints.

### Phase D — Protocol Completeness

The agent must handle and test these CDAP message families:

- `desktop_start`, `desktop_stop`, `desktop_frame`, `desktop_input`
- `codec_offer`, `codec_answer`, `keyframe_request`
- `quality_report`, `quality_update`
- `monitor_list`, `monitor_select`
- `clipboard_get`, `clipboard_set`, `clipboard_update`
- `file_list`, `file_read`, `file_write`, `file_delete`
- `audio_start`, `audio_frame`, `audio_end`
- `consent_request`, `consent_granted`, `consent_denied`

### Phase E — Tests Before “Final” Label

Required acceptance tests:

1. Linux KDE Wayland: reboot, autostart, CDAP reconnect, notification, supervised session, unattended session, input control.
2. Linux X11: same as above plus xdotool path.
3. Windows 10/11: reboot/autostart, UAC-safe background mode, screen capture, input, tray, notifications.
4. macOS: permissions prompts, screen recording, accessibility, launch agent, notification.
5. Web console and RDClient: same device, same status, same capabilities, no duplicate online records.
6. RustDesk desktop client compatibility: login, address book/ID visibility, relay, connection negotiation, encryption, and failure diagnostics.

## Immediate Next Code Step

Finish the sidecar runtime hardening: packaged binary verification, sidecar diagnostics, UI health reporting, and end-to-end supervised/unattended session tests against the web console. Until these pass, the agent should not be described as a final RDClient/RustDesk-compatible remote desktop agent.