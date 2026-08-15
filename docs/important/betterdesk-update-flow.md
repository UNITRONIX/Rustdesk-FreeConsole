# BetterDesk Update Flow

## Panel (in-app) update

- Browser self-update restart confirmation should use lightweight `/api/settings/restart-status`, not heavy/authenticated `/api/settings/info`; DB/Go backend warmup can cause false restart-timeout reports.
- Use `window.BetterDesk.cacheVersion` to distinguish the old Node.js process from the restarted one, and reload with a cache-busting query after update.
- `GET /api/settings/updates/preflight?serverUpdate=1` when server files change — blocks install if Go/prebuilt unavailable.
- After update, if server source changed but binary build/deploy failed, `applyUpdate` attempts **auto-rebuild** via `rebuildServerBinary` before leaving a stale marker.
- Console update merges new keys from `web-nodejs/.env.example` into existing `.env` using `buildEnvSubstitutions()` (resolved paths, no raw `__PLACEHOLDER__` values).
- After server updates, `patchServiceDefinitions()` sanitizes systemd/NSSM units in place.
- **Windows path root (#272):** `resolveProjectRoot()` must never resolve to a drive root (`C:\`). Default layout `C:\BetterDeskConsole` + `C:\BetterDesk` writes Scripts & Docker files under the console directory. `ensureParentDirForFile()` skips `mkdir` on filesystem roots (Node throws `EPERM` on `mkdir('C:\\')`). NSSM OpenService Access Denied when restarting `BetterDeskServer` is non-critical — restart the Go service manually or via `betterdesk.ps1` if needed.

## Issue #158 — server build / config preservation

### Root cause (original report)

GitHub `compare` API caps `files` at 300, so large diffs are truncated and changed Go callee files were not downloaded → inconsistent on-disk source and `undefined` build errors.

**Fix:** `ensureServerSource(remoteSHA, { force: true })` before every server compile/rebuild (panel update + Rebuild button).

### Installer GitHub update

- Bash: `cp -rf src/. dest/` — PS1: `Copy-Item "$src\*" $dest` (never nest source inside existing dir if rename failed).

### Configuration merge (Skansmer / boruto79 follow-ups)

- **`.env`:** `web-nodejs/lib/envMerge.js`, `scripts/merge-env.js`, `scripts/write-installer-env-subst.js` (JSON subst file — safe for special characters in passwords). Update paths append **missing keys only** with resolved values.
- **Passwords:** Panel login uses `users.password_hash` in `auth.db` / PostgreSQL. Updates must **not** change DB passwords.
- **Services:** `patch_service_definitions` / `Patch-ServiceDefinitions` on every update when units exist; full `Setup-Services` only when missing or when operator confirms recreate (`[y/N]` prompt) / `UPDATE_REFRESH_SERVICES=true`.
- **Script update failure:** GitHub update returns non-zero if Go server binary compile fails.
- **Tracked commit:** both Bash and PowerShell installers resolve the downloaded
  commit SHA through Git or the GitHub API. Tar/ZIP fallback updates refuse to
  advance tracking when the commit cannot be verified.
- **Failure recovery:** panel updates create a manifest for changed console,
  server and installer files. Critical failures automatically restore the
  manifest and any deployed server binary backup unless `autoRollback` is
  explicitly disabled.

### Stale panel warning after script / Docker update (#192)

`data/.last_update_result.json` stores the last **in-panel** update outcome. A failed panel attempt (e.g. `EACCES` on root-owned `/opt/` files) can leave a red banner even when a later **script** or **Docker** update succeeded.

An update is not considered complete until the critical source/binary steps
finish. `.update_sha`, `.agent_source_sha` and the stale-result marker are
updated only after that point. Before applying changes, the panel also checks
the writable data path and available disk space (override the 512 MiB minimum
with `UPDATE_MIN_FREE_MB` when a deployment has a documented different
requirement). If the host exposes `statfsSync` without usable block
statistics, the check is reported as unsupported rather than blocking every
Windows update.

The same cross-platform protocol harness is available after installation:

```bash
node scripts/installer-protocol-check.js \
  --api-url http://127.0.0.1:21114/api/health \
  --panel-url http://127.0.0.1:5000/health \
  --port 127.0.0.1:21116
```

Use `21121` instead of `21114` for the Docker single-container layout. The
harness distinguishes TCP reachability from HTTP success, accepts a recorded
3xx redirect, validates HTTPS certificate SANs by default, and supports
`--insecure` only for explicitly disposable/self-signed checks.

| Update path | Clears stale banner |
|-------------|---------------------|
| Settings → Updates (panel, success) | Yes — or only critical failures persisted |
| `betterdesk.sh` GitHub update | Yes — removes `.last_update_result.json` when writing `.update_sha` |
| `betterdesk.ps1` GitHub update | Yes — same as Bash |
| `betterdesk-docker.sh` GitHub rebuild | Yes — host `web-nodejs/data` + running console volume |
| `docker compose pull` (GHCR images) | Yes — console startup syncs image SHA and prunes stale result |

## Docker Compose (GHCR images)

When the console runs from `ghcr.io/.../betterdesk-console` (see `docker-compose.quick.yml`):

- Updates are **image-based**, not in-app GitHub file download + Go compile.
- Each console image embeds the build commit (`BETTERDESK_IMAGE_SHA` / `/app/.image-commit`). On startup the panel syncs `data/.update_sha` to that value, clears stale `.server_binary_stale` markers, and drops obsolete `data/.last_update_result.json` from earlier in-app attempts (#192).
- Settings → Updates shows **pull instructions** (`docker compose pull && docker compose up -d`) instead of Install / Rebuild server binary.
- `POST /api/settings/updates/install` and `rebuildServerBinary()` are rejected in this mode.

After pulling new images, recreate containers so the console picks up the embedded commit from the new image tag.

## Update channel (stable / development)

Native installs track GitHub **branch HEAD** (not tags) via `UPDATE_GITHUB_BRANCH` in `web-nodejs/.env`:

| Channel | Branch | Default |
|---------|--------|---------|
| Stable | `main` | Yes — production releases |
| Development | `dev` | Opt-in — latest work-in-progress |

Operators can switch in **Settings → Updates → Update channel**, or via installer scripts (Update → Switch update channel). See [branching-and-versioning.md](branching-and-versioning.md).

Changing channel does **not** reset `data/.update_sha`; the next update check may show a large diff against the new branch.
