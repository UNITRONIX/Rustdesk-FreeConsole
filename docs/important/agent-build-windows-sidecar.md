# Agent Client Windows Build — Sidecar Requirement

## Build pipeline (agentBuildWorker.js)
- Worker runs as ROOT (betterdesk-console service), env from /etc/betterdesk/build.env.
- Sets HOME=/home/unitronix, CARGO_HOME=/home/unitronix/.cargo, CARGO_TARGET_DIR=/var/cache/betterdesk-build.
- Materializes work dir = $CARGO_TARGET_DIR/work/<hash>/ by copying SOURCE_ROOT (only betterdesk-agent-client), SKIP: node_modules,target,dist,.git. Writes src-tauri/resources/branding.json.
- Worker only stores last 8KB stderr tail in DB error_message — real rustc/build.rs error often scrolls off. To get true error: reproduce build manually as root with build.env, log to file, grep.
- windows profile: runner=cargo-xwin, target=x86_64-pc-windows-msvc, bundles=nsis, bundleSubdir=nsis, ext=.exe.
- cargo-xwin requires rustup target x86_64-pc-windows-msvc (NOT gnu). Uses rust-lld for lld-link, symlinks clang-cl→/usr/bin/clang in ~/.cache/cargo-xwin (created by root; non-root unitronix can't overwrite → "Failed to setup clang-cl symlink / Permission denied"). Run worker-context builds as root.

## Sidecar (Phase 55) — KEY GOTCHA
- tauri.conf.json externalBin: ["binaries/betterdesk-agent"] → Tauri requires binaries/betterdesk-agent-<triple>[.exe] to EXIST at build time.
- build.rs build_go_sidecar() cross-builds Go agent ONLY if sibling source <repo>/betterdesk-agent exists (two levels up from src-tauri). In worker work-dir the sibling is ABSENT → "[sidecar] betterdesk-agent not found — skipping Go build".
- Therefore the sidecar binary MUST be pre-staged (git-tracked) in betterdesk-agent-client/src-tauri/binaries/. Linux one was committed; Windows one was MISSING → windows build failed: "resource path binaries/betterdesk-agent-x86_64-pc-windows-msvc.exe doesn't exist".
- FIX: cross-build `cd betterdesk-agent && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags '-s -w' -o ../betterdesk-agent-client/src-tauri/binaries/betterdesk-agent-x86_64-pc-windows-msvc.exe .` Commit it + scp to prod agent-source binaries/.
- For new target triples, pre-stage the matching sidecar binary the same way.# Agent Client Windows Build — Sidecar Requirement

## Build pipeline (agentBuildWorker.js)
- Worker runs as ROOT (betterdesk-console service), env from /etc/betterdesk/build.env.
- Sets HOME=/home/unitronix, CARGO_HOME=/home/unitronix/.cargo, CARGO_TARGET_DIR=/var/cache/betterdesk-build.
- Materializes work dir = $CARGO_TARGET_DIR/work/<hash>/ by copying SOURCE_ROOT (only betterdesk-agent-client), SKIP: node_modules,target,dist,.git. Writes src-tauri/resources/branding.json.
- Worker only stores last 8KB stderr tail in DB error_message — real rustc/build.rs error often scrolls off. To get true error: reproduce build manually as root with build.env, log to file, grep.
- windows profile: runner=cargo-xwin, target=x86_64-pc-windows-msvc, bundles=nsis, bundleSubdir=nsis, ext=.exe.
- cargo-xwin requires rustup target x86_64-pc-windows-msvc (NOT gnu). Uses rust-lld for lld-link, symlinks clang-cl→/usr/bin/clang in ~/.cache/cargo-xwin (created by root; non-root unitronix can't overwrite → "Failed to setup clang-cl symlink / Permission denied"). Run worker-context builds as root.

## Sidecar (Phase 55) — KEY GOTCHA
- tauri.conf.json externalBin: ["binaries/betterdesk-agent"] → Tauri requires binaries/betterdesk-agent-<triple>[.exe] to EXIST at build time.
- build.rs build_go_sidecar() cross-builds Go agent ONLY if sibling source <repo>/betterdesk-agent exists (two levels up from src-tauri). In worker work-dir the sibling is ABSENT → "[sidecar] betterdesk-agent not found — skipping Go build".
- Therefore the sidecar binary MUST be pre-staged (git-tracked) in betterdesk-agent-client/src-tauri/binaries/. Linux one was committed; Windows one was MISSING → windows build failed: "resource path binaries/betterdesk-agent-x86_64-pc-windows-msvc.exe doesn't exist".
- FIX: cross-build `cd betterdesk-agent && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags '-s -w' -o ../betterdesk-agent-client/src-tauri/binaries/betterdesk-agent-x86_64-pc-windows-msvc.exe .` Commit it + scp to prod agent-source binaries/.
- For new target triples, pre-stage the matching sidecar binary the same way.
