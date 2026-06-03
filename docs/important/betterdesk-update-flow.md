# BetterDesk Update Flow

## Panel (in-app) update

- Browser self-update restart confirmation should use lightweight `/api/settings/restart-status`, not heavy/authenticated `/api/settings/info`; DB/Go backend warmup can cause false restart-timeout reports.
- Use `window.BetterDesk.cacheVersion` to distinguish the old Node.js process from the restarted one, and reload with a cache-busting query after update.
- `GET /api/settings/updates/preflight?serverUpdate=1` when server files change — blocks install if Go/prebuilt unavailable.
- After update, if server source changed but binary build/deploy failed, `applyUpdate` attempts **auto-rebuild** via `rebuildServerBinary` before leaving a stale marker.
- Console update merges new keys from `web-nodejs/.env.example` into existing `.env` using `buildEnvSubstitutions()` (resolved paths, no raw `__PLACEHOLDER__` values).
- After server updates, `patchServiceDefinitions()` sanitizes systemd/NSSM units in place.

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
