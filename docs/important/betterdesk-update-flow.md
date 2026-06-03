# BetterDesk Update Flow

- Browser self-update restart confirmation should use lightweight `/api/settings/restart-status`, not heavy/authenticated `/api/settings/info`; DB/Go backend warmup can cause false restart-timeout reports.
- Use `window.BetterDesk.cacheVersion` to distinguish the old Node.js process from the restarted one, and reload with a cache-busting query after update.
- Issue #158 (Go server build "undefined" errors after update): root cause = GitHub `compare` API caps `files` at 300, so large diffs are truncated and changed Go callee files (codec/ws.go, peer/map.go, auth/ldap.go, auth/oidc.go) are not downloaded → inconsistent on-disk source. Fix: `ensureServerSource(remoteSHA, {force:true})` now does a FULL source resync; called from `applyUpdate` server block AND `rebuildServerBinary` (the "Rebuild server binary" button).
- Installer GitHub-update gotcha (same #158): `cp -r dir destdir` (bash) / `Copy-Item dir destdir` (PS1) NEST the new tree inside an existing dir if the pre-update rename/mv failed. Always copy CONTENTS into a guaranteed-existing dir: bash `cp -rf src/. dest/`, PS1 `Copy-Item "$src\*" $dest`.
