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

## 3. Desktop Client (Tauri)

- [ ] **Install deps**: `cd betterdesk-mgmt && pnpm install`
- [ ] **Frontend build**: `pnpm build` — no errors
- [ ] **Tauri build**: `cargo tauri build` — NSIS + MSI produced
- [ ] **Installer runs**: installs and launches without crash
- [ ] **Single-instance**: second launch brings first to foreground

## 4. Agent Client (Tauri)

- [ ] **Install deps**: `cd betterdesk-agent-client && pnpm install`
- [ ] **Build**: `cargo tauri build` — NSIS produced
- [ ] **Setup wizard**: 5-step onboarding completes successfully
- [ ] **Registration**: device appears in server peer list

## 5. Native Agent (Go)

- [ ] **Build**: `cd betterdesk-agent && go build -o betterdesk-agent .`
- [ ] **Connection**: connects to CDAP gateway, manifests registers
- [ ] **Heartbeat**: metrics flow (CPU / Memory / Disk)

## 6. Docker

- [ ] **Build all images**: `docker compose build` — no errors
- [ ] **Start stack**: `docker compose up -d` — all containers healthy
- [ ] **API reachable**: `curl http://localhost:21114/api/health` returns OK
- [ ] **Console reachable**: `curl http://localhost:5000` returns HTML
- [ ] **Single-container**: `docker compose -f docker-compose.single.yml up -d` works

## 7. Installer Scripts

- [ ] **Linux fresh**: `sudo ./betterdesk.sh --auto` on clean Ubuntu/Debian
- [ ] **Linux update**: `sudo ./betterdesk.sh` option 2 preserves DB + config
- [ ] **Windows fresh**: `.\betterdesk.ps1 -Auto` on clean Windows Server
- [ ] **Windows update**: `.\betterdesk.ps1` option 2 preserves DB + config
- [ ] **Docker script**: `./betterdesk-docker.sh` option 1 installs successfully

## 8. Documentation & Release

- [ ] **CHANGELOG.md**: updated with new version section
- [ ] **README.md**: reflects current features
- [ ] **VERSION file**: bumped to release version
- [ ] **Git tag**: `git tag v<version>` created and pushed (`git push origin v<version>`)
- [ ] **GitHub Release**: published (prerelease for alpha/beta); triggers Docker publish workflow
- [ ] **GHCR image tags**: verify `ghcr.io/unitronix/betterdesk-server`, `betterdesk-console`, and `betterdesk` show semver tag (e.g. `3.0.0-alpha`) and git ref (`v3.0.0-alpha`) after workflow completes
- [ ] **Manual fallback**: Actions → “Build & Publish Docker Images” → Run workflow → tag input `v<version>` if release trigger was skipped
- [ ] **No secrets in diff**: `git diff --cached` has no API keys / passwords
- [ ] **No debug code**: no `console.log` debug statements, no `TODO` in shipped code
