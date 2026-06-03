# agentBuildWorker.js — known gotchas (fixed 2026-05-29)

- `betterdesk-console.service` runs as User=root (NOT unitronix). systemd env is empty — `process.env.USER` is undefined → `BUILD_USER` would default to "root" → CARGO_HOME wrong.
- Fix in `web-nodejs/services/agentBuildWorker.js`:
  1. Worker now reads `/etc/betterdesk/build.env` at module load (set by `scripts/install-build-toolchain.sh`).
  2. `BUILD_USER` defaults to `unitronix` (NOT `process.env.USER`).
  3. Absolute binary paths `CARGO_BIN` / `NPM_BIN` resolved via `_resolveBin([...candidates])` to bypass spawn ENOENT (Node spawn PATH override is unreliable for systemd-root services).
  4. `_runTauriBuild` uses `CARGO_BIN` / `NPM_BIN` literals (not the string `cargo` / `npm`).
- Diagnostic log on startup: `paths cargo=... npm=... source=...` — verify these point to `/home/unitronix/.cargo/bin/cargo`, `/usr/bin/npm`, `/opt/BetterDeskConsole/agent-source/betterdesk-agent-client`.
- cargo-xwin runner CLI: `cargo tauri build --runner cargo-xwin --bundles X --target X` (NOT `cargo xwin tauri build ...`).
- Build workspace: `/var/cache/betterdesk-build/` (24 GB free needed).
- Artifact target dir: `/opt/BetterDeskConsole/data/agent-builds/<hash>/<platform>-<arch><ext>`.
- Agent source override: `AGENT_SOURCE_DIR` env (defaults to `/opt/BetterDeskConsole/agent-source/betterdesk-agent-client`).
- Toolchain installer: `scripts/install-build-toolchain.sh` (menu B in betterdesk.sh).
- Toolchain env file: `/etc/betterdesk/build.env` (BUILD_USER, CARGO_HOME, RUSTUP_HOME, CARGO_TARGET_DIR, PATH).

## Retry a failed build
```bash
sudo -u postgres psql betterdesk -c \
  "UPDATE agent_bundle_builds SET status='pending', error_message='' \
   WHERE branding_hash='<hash>' AND platform='linux' AND format='deb';"
```

## Reset admin password (PostgreSQL — reset-password.js is BROKEN, hardcoded SQLite)
```bash
HASH=$(node -e "console.log(require('bcrypt').hashSync('NEW_PW', 12))")
sudo -u postgres psql betterdesk -c \
  "UPDATE users SET password_hash='$HASH' WHERE username='admin';"
```# agentBuildWorker.js — known gotchas (fixed 2026-05-29)

- `betterdesk-console.service` runs as **User=root** (NOT unitronix). systemd env is empty —
  `process.env.USER` is undefined → `BUILD_USER` would default to "root" → CARGO_HOME wrong.
- Fix in `web-nodejs/services/agentBuildWorker.js`:
  1. Worker now reads `/etc/betterdesk/build.env` at module load (set by `scripts/install-build-toolchain.sh`).
  2. `BUILD_USER` defaults to `'unitronix'` (NOT `process.env.USER`).
  3. Absolute binary paths `CARGO_BIN` / `NPM_BIN` resolved via `_resolveBin([...candidates])`
     to bypass spawn ENOENT (Node spawn PATH override is unreliable for systemd-root services).
  4. `_runTauriBuild` uses `CARGO_BIN` / `NPM_BIN` literals (not the string "cargo" / "npm").
- Diagnostic log on startup: `paths cargo=... npm=... source=...` — verify these point to
  `/home/unitronix/.cargo/bin/cargo`, `/usr/bin/npm`, `/opt/BetterDeskConsole/agent-source/betterdesk-agent-client`.
- cargo-xwin runner CLI: `cargo tauri build --runner cargo-xwin --bundles X --target X`
  (NOT `cargo xwin tauri build ...`).
- Build workspace: `/var/cache/betterdesk-build/` (24 GB free needed).
- Artifact target dir: `/opt/BetterDeskConsole/data/agent-builds/<hash>/<platform>-<arch><ext>`.
- Agent source override: `AGENT_SOURCE_DIR` env (defaults to `/opt/BetterDeskConsole/agent-source/betterdesk-agent-client`).
- Toolchain installer: `scripts/install-build-toolchain.sh` (menu B in betterdesk.sh).
- Toolchain env file: `/etc/betterdesk/build.env` (BUILD_USER, CARGO_HOME, RUSTUP_HOME, CARGO_TARGET_DIR, PATH).

## Retry a failed build
```bash
sudo -u postgres psql betterdesk -c \
  "UPDATE agent_bundle_builds SET status='pending', error_message='' \
   WHERE branding_hash='<hash>' AND platform='linux' AND format='deb';"
```

## Reset admin password (PostgreSQL — reset-password.js is BROKEN, hardcoded SQLite)
```bash
HASH=$(node -e "console.log(require('bcrypt').hashSync('NEW_PW', 12))")
sudo -u postgres psql betterdesk -c \
  "UPDATE users SET password_hash='$HASH' WHERE username='admin';"
```
