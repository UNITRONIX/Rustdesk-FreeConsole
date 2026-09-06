# Patch Plan — 2026-04-18

## Problems reported

1. **Agent client infinite loading** — after registration the GUI shows only a spinner; nothing interactive.
2. **Web remote client is duplicated** — multiple paths/entry points. Need one canonical client at `/remote/:id` reachable from the device row kebab menu (desktop icon).
3. **Multi-connection tab close broken** — X button on top-bar tab closes the session but the tab remains; hover X does nothing.
4. **Toolbar menu actions non-functional** — Ctrl+Alt+Del, Lock screen, Restart remote, Refresh screen, Paste clipboard, Block input, quality presets, scaling modes, etc. don't send commands.
5. **3–7 FPS on any connection** — adaptive quality should be default, HTTPS preferred, best balance of FPS vs quality.

---

## Phases

### Phase A — Agent client loading
- Make `get_agent_status` fast: drop `SystemSnapshot::collect()` from the hot path, read-only fields from cached config.
- Split slow sysinfo into a separate `get_system_info` command that UI polls lazily.
- Frontend: wrap `onMount` `invoke` calls in `Promise.race` with a 3 s timeout so `setReady(true)` is always reached.
- Add explicit error UI when Tauri IPC fails.

### Phase B — Unify remote entry
- Make `/remote/:id` the single canonical entry point.
- All device-row kebab "Remote desktop" buttons route to `/remote/:id` (no more legacy `/web-client`, `/remote-client`, modal launchers).
- Remove/redirect any legacy routes.

### Phase C — Multi-connection tab close
- Fix DOM sync between session store and top-bar tabs.
- X button should call `closeSession(id)` which both terminates the session AND removes the tab from the store.
- Handle already-closed sessions gracefully (remove tab on connection `close` event too).

### Phase D — Toolbar commands
Wire up each menu action through the existing RustDesk `Misc` protocol messages:
- **Ctrl+Alt+Del** → `ctrl_alt_del` Misc option.
- **Lock screen** → `lock_screen` Misc option.
- **Restart remote** → `restart_remote_device` Misc option.
- **Refresh screen** → `refresh_video` Misc option (keyframe request).
- **Paste clipboard** → read navigator.clipboard, send `clipboard` message.
- **Block input** → `block_input` Misc option toggle.
- **Quality presets** → `image_quality` Misc option: Best / Balanced / Performance.
- **Scaling modes** → CSS-only: fit / fill / original / stretch.
- **Show remote cursor** → client-side toggle of cursor overlay.
- **Disable clipboard / privacy mode / lock after session** → respective Misc options.

### Phase E — Adaptive quality + HTTPS
- Default imageQuality: `Balanced`, customFps: 45.
- Run `AdaptiveQuality` loop: measure RTT + decoded FPS; if decode FPS > 25 and bandwidth headroom → promote to `Best`; if decode FPS < 15 or high packet loss → demote to `Performance`.
- When page served over HTTPS, prefer WebCodecs (VP9/AV1/H264) with `Auto` preference. On HTTP, fall back to JMuxer H264-only.
- Auto `refresh_video` on resize + after 5 s stall.
- Trim MSE SourceBuffer above 2 s to prevent freeze (already in video.js — verify).

### Phase F — Rebuild
- Build agent installer (MSI + NSIS).

---

## Execution order
A → B → C → D → E → F

Each phase is independent and can be deployed as soon as it completes.
