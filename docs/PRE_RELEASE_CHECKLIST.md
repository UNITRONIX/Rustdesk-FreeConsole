# Pre-Release Validation Checklist

Use this checklist before every tagged release to ensure quality and stability.

---

## 1. Go Server

- [ ] **Build**: `cd betterdesk-server && go build -o betterdesk-server .` — exits 0
- [ ] **Vet**: `go vet ./...` — no warnings
- [ ] **Tests**: `go test ./...` — all pass
- [ ] **Cross-compile**: `GOOS=linux GOARCH=amd64`, `GOOS=linux GOARCH=arm64`, `GOOS=windows GOARCH=amd64`
- [ ] **Binary starts**: runs with `--help`, prints version
- [ ] **SQLite migration**: fresh DB created and migrated automatically
- [ ] **PostgreSQL migration**: (if available) fresh DB created and migrated

## 2. Node.js Console

- [ ] **Install**: `cd web-nodejs && npm ci` — exits 0
- [ ] **Audit**: `npm audit --omit=dev` — 0 vulnerabilities (or documented exceptions)
- [ ] **Unit tests**: `npm test` — all pass
- [ ] **i18n coverage**: `npm run i18n:check` — 0 missing keys across all languages
- [ ] **Startup**: `node server.js` starts without errors, serves on port 5000
- [ ] **Login**: Admin login works, session created
- [ ] **Critical pages**: Dashboard, Devices, Users, Settings render correctly

## 3. RdClient Desktop (Tauri)

- [ ] **Install deps**: `cd rdclient-desktop && npm ci`
- [ ] **Rust check**: `cd rdclient-desktop/src-tauri && cargo check && cargo test discovery`
- [ ] **Tauri build**: `npm run build` — deb/AppImage/MSI as configured
- [ ] **Setup**: LAN discovery or manual URL; `probe_server_url` rejects non-panel hosts
- [ ] **Settings**: sign out, reset client clears cookies + vault
- [ ] **Linux session**: VP9/H.264 stable on WebKitGTK (no AV1 decode loop)
- [ ] **Windows**: WebView2 runtime present; session connects
- [ ] **Generator RdClient**: new bundle → 6 platform builds queue on build host with Rust/Tauri toolchain

## 4. Desktop Client (Tauri — legacy betterdesk-mgmt)

- [ ] **Install deps**: `cd betterdesk-mgmt && pnpm install`
- [ ] **Frontend build**: `pnpm build` — no errors
- [ ] **Tauri build**: `cargo tauri build` — NSIS + MSI produced
- [ ] **Installer runs**: installs and launches without crash
- [ ] **Single-instance**: second launch brings first to foreground

## 5. Agent Client (Tauri)

- [ ] **Install deps**: `cd betterdesk-agent-client && pnpm install`
- [ ] **Build**: `cargo tauri build` — NSIS produced
- [ ] **Setup wizard**: 5-step onboarding completes successfully
- [ ] **Registration**: device appears in server peer list

## 6. Native Agent (Go)

- [ ] **Build**: `cd betterdesk-agent && go build -o betterdesk-agent .`
- [ ] **Connection**: connects to CDAP gateway, manifests registers
- [ ] **Heartbeat**: metrics flow (CPU / Memory / Disk)

## 7. Docker

- [ ] **Build all images**: `docker compose build` — no errors
- [ ] **Start stack**: `docker compose up -d` — all containers healthy
- [ ] **API reachable**: `curl http://localhost:21114/api/health` returns OK
- [ ] **Console reachable**: `curl http://localhost:5000` returns HTML
- [ ] **Single-container**: `docker compose -f docker-compose.single.yml up -d` works

## 8. Installer Scripts

- [ ] **Linux fresh**: `sudo ./betterdesk.sh --auto` on clean Ubuntu/Debian
- [ ] **Linux update**: `sudo ./betterdesk.sh` option 2 preserves DB + config
- [ ] **Windows fresh**: `.\betterdesk.ps1 -Auto` on clean Windows Server
- [ ] **Windows update**: `.\betterdesk.ps1` option 2 preserves DB + config
- [ ] **Docker script**: `./betterdesk-docker.sh` option 1 installs successfully

## 9. Documentation & Release

Applies only to merges into **`main`** (stable). Version bump, tag, and GitHub Release are automated by [`.github/workflows/version-bump-main.yml`](../../.github/workflows/version-bump-main.yml) — see [branching-and-versioning.md](important/branching-and-versioning.md).

- [ ] **PR source:** changes merged from `dev` → `main` (not direct commits to `main`)
- [ ] **CHANGELOG.md:** `[Unreleased]` section reflects this release (CI moves it into the version section on merge)
- [ ] **README.md:** reflects current features
- [ ] **Version parity:** `node scripts/bump-version.js --verify` passes locally (CI enforces on version file changes)
- [ ] **After merge:** verify CI created tag `v<version>` and GitHub Release
- [ ] **GHCR image tags:** verify `ghcr.io/unitronix/betterdesk-server`, `betterdesk-console`, and `betterdesk` show semver tag (e.g. `3.1.0`) and git ref (`v3.1.0`) after workflow completes
- [ ] **Sync dev:** merge `main` → `dev` so development continues from the new minor version
- [ ] **Manual fallback:** Actions → “Build & Publish Docker Images” → Run workflow → tag input `v<version>` if release trigger was skipped
- [ ] **No secrets in diff:** `git diff --cached` has no API keys / passwords
- [ ] **No debug code:** no `console.log` debug statements, no `TODO` in shipped code
