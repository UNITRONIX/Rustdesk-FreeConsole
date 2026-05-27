# BetterDesk Agent Client — Roadmap 2026-05-27

> Owner: BetterDesk core team. Status: planning + phase 1 in progress.
> Driving requirement: deliver a finished agent client that exposes capabilities
> RustDesk's standard agent does not offer, while remaining compatible with
> RustDesk desktop client connections where the protocol allows it.

This document is the single source of truth for the agent client roadmap. It
supersedes the high-level outline in
[`AGENT_CLIENT_FINALIZATION_PLAN_2026-05-06.md`](AGENT_CLIENT_FINALIZATION_PLAN_2026-05-06.md)
for everything that follows phase A. Each phase below is independently
shippable and includes its own acceptance tests so the user can verify the
build on their own machine before the next phase begins.

## Non-negotiable invariants

These hold for every phase. Reviewers must reject any change that violates
them.

- **Background-first**: the agent must run silently from system boot. The
  end user never has to launch the GUI manually for the agent to be
  reachable.
- **Tamper resistance**: a standard logged-in user cannot disable CDAP,
  unregister the device, change capability gates, edit profile data, or
  approve OTA updates. Those actions require either the local OS
  administrator credential (root / local Administrator group / sudo) or
  the server-wide master password configured by the BetterDesk
  administrator.
- **Encrypted at rest**: tokens, master-password verifier hash, profile
  contacts, chat history cache, branding configuration, and any cached
  credentials are stored encrypted in the OS keyring (preferred) or with
  an AES-GCM-wrapped local key as fallback. Plain JSON on disk is
  forbidden for these fields.
- **One-way remote**: this agent never initiates outbound remote-desktop
  sessions to other agents. It only accepts inbound sessions from
  operators or BetterDesk MGMT clients.
- **i18n**: every new user-facing string is added to EN and PL locale
  files in the same change. Hardcoded English in components is a build
  failure.
- **Audited**: every privileged action (settings unlock, profile change,
  OTA approval, supervised consent decision, chat employee-handover)
  produces an audit event on the server.

## Phase map

| Phase | Title | Status | Tested by user |
|------:|-------|--------|----------------|
| 1 | Supervised/Unattended access + on-screen overlay | in progress | pending |
| 2 | Settings lock (OS admin OR server master password) | not started | pending |
| 3 | Extended user profile (name, position, phone, photo) | not started | pending |
| 4 | Agent-to-agent chat + file transfer + employee handover | not started | pending |
| 5 | On-device branding configurator | not started | pending |
| 6 | "Client Generator" tab in Node.js web console | not started | pending |
| 7 | OTA updates (server-gated) | not started | pending |
| 8 | RustDesk parity (H.264, audio, multi-monitor) | not started | pending |

Phases ship in order. Phases 5 and 6 are coupled — branding configurator on
the device consumes deployment bundles produced by the web generator.

---

## Phase 1 — Supervised / unattended access + on-screen overlay

### Goals

1. Add an `access_mode` policy to agent config with three values:
   - `supervised` — every inbound session must be approved via the
     consent dialog (current default).
   - `unattended` — sessions start immediately without prompting the
     user.
   - `disabled` — remote desktop sessions are rejected outright.
2. Render an always-on-top overlay during an active session, on **every
   monitor**:
   - A coloured border frame around each screen (configurable colour;
     default amber for supervised, red for unattended).
   - A small collapsible "session widget" anchored to the bottom-right
     of the primary monitor showing operator name, elapsed time,
     "Disconnect" and "Chat" buttons, with a one-click collapse to a
     tiny floating badge.
3. Update `require_consent` to be a *derived* field — `access_mode ==
   "supervised"` implies `require_consent=true`. Keep `require_consent`
   only as a wire-compat hint for older config files.

### Implementation notes

- `betterdesk-agent-client/src-tauri/src/config.rs` gains
  `access_mode: AccessMode { Supervised, Unattended, Disabled }` and
  serializes the legacy `require_consent` field automatically based on
  the enum value.
- `to_sidecar_config()` continues to pass `require_consent` to the Go
  sidecar; the Go side keeps its current consent flow. The "disabled"
  mode is enforced both in the Tauri config (rejects sessions before
  they reach the sidecar) and on the server side (operators see the
  device as `remote_disabled`).
- The overlay is a separate `tauri::WindowBuilder` window per monitor,
  flagged `transparent`, `skip_taskbar`, `always_on_top`, with input
  pass-through enabled outside the widget area. The widget area is the
  only opaque region and traps clicks.
- The overlay subscribes to a new `session-active` Tauri event emitted
  by the sidecar stdout reader when `desktop_start` succeeds, and a
  matching `session-ended` event on stream close.
- Add Go-side events: emit `SESSION_START:{...}` / `SESSION_END:{...}`
  on stdout in `desktop.go` so the Tauri wrapper can drive the overlay
  state machine without polling.

### New IPC commands

- `get_access_mode() -> AccessMode`
- `set_access_mode(mode)` — gated by phase 2 settings lock once
  available; phase 1 keeps the existing admin check as a placeholder.
- `disconnect_active_session(session_id)`
- `get_active_sessions() -> Vec<SessionInfo>`

### Acceptance tests (user verifies on their machine)

1. Set `access_mode=supervised`, trigger an operator session, confirm
   the consent dialog appears and the amber border + widget render on
   all monitors after the user accepts.
2. Set `access_mode=unattended`, trigger a session, confirm no consent
   dialog and the red border + widget render immediately.
3. Set `access_mode=disabled`, attempt a session, confirm the operator
   receives a clear "remote disabled by user policy" error and no
   overlay appears.
4. Click "Disconnect" in the widget, confirm the session ends within
   one second and the overlay disappears on every monitor.
5. Collapse the widget, confirm it shrinks to a floating badge and
   restores on click without losing elapsed-time accuracy.

---

## Phase 2 — Settings lock (OS admin OR server master password)

### Goals

The agent's Settings, Unregister, and capability-gate panels become a
privileged surface. The user can unlock them in either of two ways:

1. **Local OS administrator**: the agent prompts for credentials and
   verifies them through:
   - Linux: PolicyKit (`org.freedesktop.policykit1.exec.allow_any`)
     via `pkexec`, or `pam_unix` validation through a small
     setuid helper if PolicyKit is unavailable.
   - Windows: `LogonUser(LOGON32_LOGON_INTERACTIVE,
     LOGON32_PROVIDER_DEFAULT)` against the local Administrators
     group.
   - macOS (future): `Authorization Services` framework.
2. **Server master password**: a single password configured by the
   BetterDesk admin in the web console. The agent sends the candidate
   to a new server endpoint (`POST /api/agent/master-auth`) protected
   by the agent's CDAP credentials. The server verifies against a
   bcrypt hash and returns a short-lived (5 min) settings-unlock
   token.

After unlock, the Settings panel stays open for 10 minutes (configurable
on the server, hard cap 60 min). Any privileged IPC command checks the
in-memory unlock token and rejects requests when it has expired.

### Implementation notes

- New module `betterdesk-agent-client/src-tauri/src/settings_lock.rs`
  with `SettingsLock::request_unlock`, `validate_token`, `revoke`.
- Token is a random 32-byte value stored only in process memory; never
  persisted to disk.
- Audit: every unlock attempt (success or failure) is logged to the
  server via the existing audit endpoint, including method (`os_admin`
  vs `server_master`), client IP, and operator if available.
- Server-side: new bcrypt-hashed column `agent_master_password_hash`
  on `server_config`. Web settings panel exposes "Set / change agent
  master password" with the same UX as the existing admin password
  reset.
- Brute-force protection: 5 failed attempts within 5 minutes locks the
  Settings panel for 15 minutes and emits a `settings_lockout` audit
  event. Server endpoint enforces the same rate limit per agent.

### Acceptance tests

1. With no server master password set, unlock via OS admin succeeds.
2. With OS admin password incorrect, unlock fails and `settings_unlock_failed`
   appears in the server audit log.
3. Set the server master password from the web panel, restart the
   agent, confirm unlock via that password works without needing OS
   admin.
4. Submit 5 wrong passwords in a row; confirm 15-minute lockout
   triggers and audit event appears.
5. Wait 10 minutes after unlock, attempt to change a capability gate,
   confirm the agent prompts to unlock again.

---

## Phase 3 — Extended user profile

### Goals

A new "Profile" page in the agent collects optional information about the
person using the device:

- Full name
- Job title / position
- Department (free text)
- Phone number
- Email
- Profile photo (JPEG/PNG ≤ 512 KB; auto-resized to 256×256)
- Free-text "About me"

The page is editable by the end user (no settings lock required). The
data is sent to the server via a new `POST /api/agent/profile` endpoint
and is visible in the device detail panel of the web console.

### Implementation notes

- Profile fields are stored encrypted in the OS keyring under
  `betterdesk-agent.profile.<device_id>`. Photo is base64 in the same
  blob.
- Server table `peer_profiles (peer_id, full_name, position,
  department, phone, email, photo_bytea, about, updated_at)`.
- Web console adds a read-only "Profile" tab on the device detail
  page and renders the photo as a 64×64 avatar in the device list.
- The profile blob is signed by the agent's auth token to prevent
  tampering by a malicious sidecar process.

### Acceptance tests

1. Fill the profile form, save, confirm the data appears in the web
   console without refreshing.
2. Upload a 1 MB photo, confirm the agent rejects with a clear
   "photo too large" error.
3. Clear the photo, confirm the avatar in the web console reverts to
   the default initials badge.

---

## Phase 4 — Agent-to-agent chat with file transfer + employee handover

### Goals

1. **Contact list** in the agent shows every other agent registered on
   the same server, grouped by online state. Operators and admins are
   highlighted with a distinct colour/icon. Inactive ("sleeping")
   profiles created by an employee handover are hidden from the
   chooser but their history is preserved.
2. **One-to-one chat** between any two agents, persisted in the server
   database (`chat_messages` and `chat_threads` tables, encrypted with
   the existing `chatCrypto.js` E2E module from Phase 2 of the chat
   system).
3. **File transfer ≤ 100 MB** per file with progress feedback and a
   simple antivirus heuristic (extension blacklist, max-size enforced
   server-side too).
4. **Employee handover**:
   - Settings → Profile → "Hand over this workstation to another
     employee" wizard.
   - Requires settings unlock (phase 2).
   - The current profile is marked `status=sleeping`, hidden from
     contact lists, and its chat threads become read-only.
   - A new profile is collected (phase 3 fields), assigned a new
     identity within the same device record.
   - The chat history of the previous employee is preserved on the
     server but no peer can post to those threads.

### Implementation notes

- File transfer reuses the existing CDAP `file_*` message family with
  a new `chat_file_offer` / `chat_file_chunk` extension to keep large
  transfers off the desktop streaming path.
- Server enforces the 100 MB limit and the extension blacklist before
  forwarding any chunks.
- Employee handover audits: `employee_handover_started`,
  `employee_handover_completed`. Both include the outgoing and
  incoming profile identifiers.

### Acceptance tests

1. Send a 50 MB ZIP between two agents, confirm progress UI updates
   and SHA-256 of the received file matches the sender.
2. Attempt to send a 150 MB file, confirm the agent rejects locally
   with a clear error before any upload starts.
3. Run an employee handover, confirm the old profile becomes hidden
   in the contact list of a third agent, the old threads are
   read-only, and the new profile receives messages normally.

---

## Phase 5 — On-device branding configurator

The agent ships as a single neutral binary. After installation, an
administrator can run `betterdesk-agent --configure` (or use the
Settings → Branding page after unlock) to:

- Set custom application name, tray icon, primary colour, logo.
- Optionally fetch a deployment bundle (phase 6) from the server.

Bundle storage: signed JSON wrapped with AES-GCM using a key derived
from the OS keyring. The agent verifies the signature against the
public key embedded in the binary at compile time; bundles signed by
unknown keys are rejected.

## Phase 6 — Client Generator panel in Node.js web console

A new top-level navigation entry "Client Generator" in the web console
lets admins produce deployment bundles consumed by phase 5. The bundle
contains:

- Server address(es), API key, CDAP port.
- Branding (name, colour, logo PNG, tray icon).
- Default capability gates and access mode.
- Optional master-password reset trigger.

The bundle is downloadable as a `.bdbundle` file and pushed to the
agent through the OTA channel when phase 7 is live.

## Phase 7 — OTA updates

Server-side approval workflow:

1. Admin uploads a new agent build (`.tar.gz`) to the web console.
2. The release is staged behind a "Roll out" toggle, optionally to a
   subset of devices via tag filter.
3. Each agent polls `GET /api/agent/update-channel`, downloads the
   approved release, verifies signature, applies it on next restart.

Self-update is gated by either OS admin credentials or the server
master password; an unattended-only flag in the channel definition
allows zero-touch installs in managed environments.

## Phase 8 — RustDesk parity

The final phase. Pulled directly from
[`AGENT_CLIENT_FINALIZATION_PLAN_2026-05-06.md` Phase C/D](AGENT_CLIENT_FINALIZATION_PLAN_2026-05-06.md):

- Linux: X11 / Wayland (PipeWire portal), VAAPI / NVENC / AMF.
- Windows: DXGI / Windows Graphics Capture, Media Foundation / NVENC.
- macOS: ScreenCaptureKit, VideoToolbox.
- CDAP message families: `desktop_*`, `codec_*`, `monitor_*`,
  `clipboard_*`, `file_*`, `audio_*`, `consent_*`.

This phase is gated by the user; we revisit when phases 1–7 are
shipping in production.

---

## Testing protocol between phases

1. The implementer pushes the change and writes the matching acceptance
   tests above.
2. The user runs the build on their workstation (Linux, primary
   target) and reports against the test list.
3. Bugs are fixed in the same phase before the next phase starts.
4. Once accepted, the phase is marked complete in this document and a
   short "what changed" note is appended to
   [`.github/copilot-instructions.md`](../.github/copilot-instructions.md).

## Open questions

These are tracked but do not block phase 1 execution.

- Should the on-screen overlay also pulse when CDAP reconnects after a
  drop, or stay quiet?
- Should the employee-handover wizard offer to export the old
  employee's chat history as a PDF before sealing it?
- Should the master password support per-device override values, or is
  one server-wide value enough?

Updates to this roadmap go through the same review process as code.
