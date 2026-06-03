# Agent Client Roadmap (2026-05-27) — user-requested

User wants step-by-step implementation with on-machine testing between phases.

Confirmed priorities (in order):
1. Supervised/unattended access + on-screen overlay (TV-style frame on each monitor + collapsible widget)
2. Settings lock — OS admin (root/local Administrator) OR server-side master password (configured on server, verified by agent against server)
3. Extended user profile (name, position, phone, photo) — editable in agent, synced to Node.js panel
4. Agent-to-agent chat with file transfer ≤100MB + employee handover (old user → sleep/unavailable, new user takes over, history preserved but hidden from chat partners)
5. Branding: NOT baked into binary — configurator on target device with secure data storage
6. Client Generator panel in Node.js web (defines branding + initial config bundle to deploy)
7. OTA updates (server-gated approval, agent self-update)
8. RustDesk parity (H.264, audio, multi-monitor) — last phase

Chat storage: persistent in DB (server). Employee change preserves old user data, marks old account as "sleeping/unavailable", peers cannot send to sleeping accounts.

Settings lock detail: agent verifies password locally first (OS admin via PAM/Windows API). If server master password is set, agent submits to server endpoint for verification. Two unlock paths: local OS admin OR server master.

Doc: docs/AGENT_CLIENT_ROADMAP_2026-05-27.md

## Phase 1 progress (backend foundation complete, cargo check passes)
- config.rs: `AccessMode` enum (Supervised/Unattended/Disabled), migration from legacy `require_consent`, `sync_access_mode()`, `to_sidecar_config()` honors Disabled
- desktop.go: emits `SESSION_START:{...}` and `SESSION_END:{...}` lines on stdout
- sidecar.rs: parses SESSION_START/END, emits `session-active`/`session-ended` Tauri events, mirrors into `AgentState.active_sessions`
- commands.rs: `AgentSettings.access_mode` field, IPC commands `get_access_mode`, `set_access_mode` (restarts sidecar), `get_active_sessions`, `disconnect_active_session`
- sidecar.rs: `send_disconnect(session_id)` writes `DESKTOP_STOP:<id>` to child stdin (Go agent must handle this in stdin reader — NOT YET WIRED on Go side)
- lib.rs: new commands registered, `active_sessions: Mutex::new(Vec::new())` added
- Fedora deps installed: gtk3-devel webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel libsoup3-devel

## Phase 1.1 COMPLETE — ready for on-machine test
- Go agent stdin: `DESKTOP_STOP:<session_id>` parsed in agent.go stdinConsentReader, calls desktopStreams.LoadAndDelete + Stop()
- SessionOverlay.tsx: created (~200 LOC), border + collapsible widget, listens session-active/ended, ticker 1s, disconnect_active_session IPC
- App.tsx: SessionOverlay imported + mounted in RegisteredShell next to ConsentDialog
- global.css: appended SessionOverlay styles (.session-overlay-border, --supervised/--unattended, widget, toggle, body, etc.) + settings-access-mode radio styles
- SettingsPanel: 3-option radio group (supervised/unattended/disabled), updates require_consent for back-compat
- i18n en+pl: session.* (8 keys) + access_mode.* (8 keys) added; zh-TW still missing consent block (falls back to en)
- cargo check --lib: PASSES (Go agent re-built by build.rs)
- TS check: not run locally (node not installed on dev shell) — will type-check on user's machine via `npm run tauri dev`

## Phase 1.2 deferred
- Per-monitor overlay windows (Tauri WindowBuilder transparent+always_on_top per monitor) — currently single in-app overlay only

## Next: Phase 2 settings lock (OS admin OR server master password)# Agent Client Roadmap (2026-05-27) — user-requested

User wants step-by-step implementation with on-machine testing between phases.

Confirmed priorities (in order):
1. Supervised/unattended access + on-screen overlay (TV-style frame on each monitor + collapsible widget)
2. Settings lock — OS admin (root/local Administrator) OR server-side master password (configured on server, verified by agent against server)
3. Extended user profile (name, position, phone, photo) — editable in agent, synced to Node.js panel
4. Agent-to-agent chat with file transfer ≤100MB + employee handover (old user → sleep/unavailable, new user takes over, history preserved but hidden from chat partners)
5. Branding: NOT baked into binary — configurator on target device with secure data storage
6. Client Generator panel in Node.js web (defines branding + initial config bundle to deploy)
7. OTA updates (server-gated approval, agent self-update)
8. RustDesk parity (H.264, audio, multi-monitor) — last phase

Chat storage: persistent in DB (server). Employee change preserves old user data, marks old account as "sleeping/unavailable", peers cannot send to sleeping accounts.

Settings lock detail: agent verifies password locally first (OS admin via PAM/Windows API). If server master password is set, agent submits to server endpoint for verification. Two unlock paths: local OS admin OR server master.

Doc: docs/AGENT_CLIENT_ROADMAP_2026-05-27.md

## Phase 1 progress (backend foundation complete, cargo check passes)
- config.rs: `AccessMode` enum (Supervised/Unattended/Disabled), migration from legacy `require_consent`, `sync_access_mode()`, `to_sidecar_config()` honors Disabled
- desktop.go: emits `SESSION_START:{...}` and `SESSION_END:{...}` lines on stdout
- sidecar.rs: parses SESSION_START/END, emits `session-active`/`session-ended` Tauri events, mirrors into `AgentState.active_sessions`
- commands.rs: `AgentSettings.access_mode` field, IPC commands `get_access_mode`, `set_access_mode` (restarts sidecar), `get_active_sessions`, `disconnect_active_session`
- sidecar.rs: `send_disconnect(session_id)` writes `DESKTOP_STOP:<id>` to child stdin (Go agent must handle this in stdin reader — NOT YET WIRED on Go side)
- lib.rs: new commands registered, `active_sessions: Mutex::new(Vec::new())` added
- Fedora deps installed: gtk3-devel webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel libsoup3-devel

## Phase 1.1 COMPLETE — ready for on-machine test
- Go agent stdin: `DESKTOP_STOP:<session_id>` parsed in agent.go stdinConsentReader, calls desktopStreams.LoadAndDelete + Stop()
- SessionOverlay.tsx: created (~200 LOC), border + collapsible widget, listens session-active/ended, ticker 1s, disconnect_active_session IPC
- App.tsx: SessionOverlay imported + mounted in RegisteredShell next to ConsentDialog
- global.css: appended SessionOverlay styles (.session-overlay-border, --supervised/--unattended, widget, toggle, body, etc.) + settings-access-mode radio styles
- SettingsPanel: 3-option radio group (supervised/unattended/disabled), updates require_consent for back-compat
- i18n en+pl: session.* (8 keys) + access_mode.* (8 keys) added; zh-TW still missing consent block (falls back to en)
- cargo check --lib: PASSES (Go agent re-built by build.rs)
- TS check: not run locally (node not installed on dev shell) — will type-check on user's machine via `npm run tauri dev`

## Phase 1.2 deferred
- Per-monitor overlay windows (Tauri WindowBuilder transparent+always_on_top per monitor) — currently single in-app overlay only

## Next: Phase 2 settings lock (OS admin OR server master password)
