# BetterDesk security and stability audit — 2026-08-15

## Scope and method

This audit covers the current `dev` working tree and its native Linux,
Windows, Docker, Node.js, Go, Tauri and agent paths. Existing working-tree
changes were preserved and treated as in-scope. The operator-provided Linux
host was updated only after a protected PostgreSQL/configuration backup.

The audit used source review, focused regression tests, dependency scanners,
static checks and build checks. A clean production verdict still requires the
isolated lifecycle smoke test from `docs/PRE_RELEASE_CHECKLIST.md`.

## Remediated findings

### P1 — Device identity could be supplied independently of its bearer token

Device-facing Node routes now use the shared `middleware/deviceAuth.js`.
Bearer tokens must be bound to a valid device ID, and claimed body/query/header
IDs must match the token. The legacy pre-enrollment `/api/bd/register` path
still accepts `X-Device-Id` for a new device, but a bearer-bound device cannot
register another ID.

Regression coverage:

- `tests/deviceAuth.middleware.test.js`
- `tests/bd-api.routes.test.js`

### P1 — Unauthenticated or over-privileged WebSocket upgrades

Agent chat upgrades now require a valid device token. Operator chat upgrades
require `chat.access`, and remote viewer upgrades require `device.connect`.
Origin enforcement and the existing session checks remain in place.

Regression coverage:

- `tests/chatRelay.protocol.test.js`
- existing WebSocket relay security tests

### P1 — Agent file-browser traversal and symlink escape

`betterdesk-agent/agent/filebrowser.go` now validates relative paths with
`filepath.Rel`, resolves the existing path prefix and rejects symlink escapes.

Regression coverage:

- `betterdesk-agent/agent/filebrowser_security_test.go`

### P0/P1 — Root escalation through mutable update scripts

The previous Linux update design allowed a console-owned process to invoke
repository JavaScript as root through sudoers and service hooks. That path is
closed:

- sudoers now exposes only the root-owned
  `/usr/local/libexec/betterdesk/betterdesk-privileged-update.js`;
- the broker accepts only `daemon_reload` and restart of
  `betterdesk-console` or `betterdesk-server`;
- the panel no longer sudo-executes `linux-ensure-console-user.js`,
  `linux-deploy-server-binary.js` or systemd-unit writers;
- generated units no longer contain the root `ExecStartPre=+...` hook;
- root-owned Go binaries and protected systemd units require an explicit root
  maintenance/deploy step.

Migration is mandatory on existing Linux installations:

```bash
sudo node web-nodejs/scripts/linux-ensure-console-user.js
sudo visudo -cf /etc/sudoers.d/betterdesk-console-updates
sudo systemctl cat betterdesk-console
```

The unit must not contain an `ExecStartPre` that runs
`linux-ensure-console-user.js`. Do not add a broad `systemctl`, `journalctl` or
mutable-repository-script sudoers rule.

### P1 — Go standard-library vulnerabilities

The server toolchain is now pinned to Go `1.26.6`, fixing the six reachable
standard-library findings reported by `govulncheck` for Go `1.26.5`.

### P1 — Tauri client accepted invalid TLS by default

The agent client now validates certificates by default. Invalid certificates
require the explicit development-only `BETTERDESK_ALLOW_INVALID_TLS=1` override.
Remote plaintext CDAP is rejected by default for the Tauri agent; local
development remains compatible.

### P1 — RdClient panel probing accepted invalid TLS by default

New `rdclient-desktop` configurations now enable strict certificate validation
for panel probing and WebView traffic. Self-signed compatibility remains an
explicit setting rather than the default, and the settings screen now labels
that downgrade as a development-only choice.

### P1 — CDAP plaintext and runtime-secret exposure on the deployed Linux host

The Go server now supports `CDAP_TLS_REQUIRED=Y`, which wraps the CDAP listener
in TLS-only mode and rejects plaintext requests. The deployed host uses this
setting; its WSS health endpoint passes and an HTTP request to port `21122` is
rejected.

The deployed native systemd unit no longer puts the PostgreSQL URL or bootstrap
password in `ExecStart`/`/proc/<pid>/cmdline`. The database role password was
rotated, the shared `.env` is mode `600`, the Go binary is root-owned `755`,
and the fixed root update broker/sudoers migration completed successfully.

The installer protocol checker now recognizes Node.js IP SAN representations
(`IP Address:`) and captures the peer certificate before the response socket
is released.

### P2 — Nondeterministic vault tamper test

The peer-vault test now flips a decoded ciphertext byte instead of changing a
base64 character whose padding bits could be ignored by the decoder.

## Remaining risks and conditions

### P1 conditional — Plaintext CDAP remains the compatibility default

The Go CDAP gateway still supports dual-mode plain/TLS operation by default for
legacy clients, but existing installations must explicitly opt into the new
strict mode. A WAN deployment that exposes `ws://` can disclose API keys, device
tokens and commands.

Production condition: set `CDAP_TLS_REQUIRED=Y`, use `wss://`, and use a valid
trusted certificate or SPKI pin. Native Go agents must set
`BDAGENT_ENFORCE_TLS=Y`; Tauri agents use the secure default. Do not expose
port `21122` as plaintext to an untrusted network.

### P2 — CSP compatibility exceptions

The remote viewer still needs scoped `unsafe-eval` for protobuf.js runtime
code generation, and some pages retain `script-src-attr unsafe-inline`.
This is not an authentication bypass in the current design, but replacing
runtime protobuf generation and removing inline event handlers would further
reduce XSS impact.

### P2 — Browser-level end-to-end coverage

Server, protocol and route tests are substantial, but browser E2E coverage for
viewer/chat/permission transitions is still thinner than the server tests.
Add disposable-browser coverage before calling the posture maximum-security.

### P2 — Locale fallback baseline is already failing

The two missing `en.json` keys were added, so the EN/PL key baseline is now
consistent. `npm run i18n:check:all` still fails on hundreds of pre-existing
English fallback values across the non-English locales (and a small metadata
parity difference). This remains a release-quality issue requiring a reviewed
all-locale translation pass; no placeholder translations were deployed.

## Verification results

Passed:

- `go test ./...` in `betterdesk-server`
- `go test -race ./...` in `betterdesk-server`
- `go vet ./...` in `betterdesk-server`
- `govulncheck ./...` in `betterdesk-server` after Go `1.26.6`
- `go test ./...` in `betterdesk-agent`
- `go test -race ./...` and `go vet ./...` in `betterdesk-agent`
- `npm run test:ci` in `web-nodejs` — 93 suites passed, 610 tests
  passed, 2 suites skipped
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities
- `npm run check:frontend`
- `cargo check --locked` for the Tauri agent client
- `cargo check --locked` and `cargo test --locked` for RdClient — 6 tests
  passed
- `npm run protocols:check`, the IP-SAN regression test, PowerShell parser/help
  checks and Docker Compose config validation
- Docker split layout build/runtime smoke — both containers healthy; API and
  console health passed
- Docker single-container build/runtime smoke — API and console health passed;
  default SQLite compose now parses without `PG_PASSWORD`
- Remote Linux update to `3.5.38`: Go API/HTTPS console health, strict CDAP
  TLS health, plaintext CDAP rejection and certificate-aware protocol matrix
- Remote Linux privilege migration: valid sudoers, root-owned broker,
  `User=betterdesk`, no legacy root `ExecStartPre`, and protected binary
  deployment
- `node scripts/bump-version.js --verify`
- JavaScript syntax checks and `git diff --check`
- Independent read-only security review of the uncommitted diff — no new
  medium, high or critical finding; legacy Linux sudoers still requires the
  documented root migration.

Known environment/baseline limitations:

- `npm run i18n:check:all` fails as described above.
- `cargo fmt --all -- --check` reports pre-existing formatting differences
  across the Tauri workspace; the build itself passes.
- Bash syntax checks could not run on this Windows host because `/bin/bash`
  is unavailable.
- Disposable Linux/Windows fresh-install → update → rollback → repair →
  uninstall lifecycle tests were not run from this workstation.
- The deployed panel certificate is self-signed. The protocol matrix passes
  when that certificate is explicitly installed as a trust anchor; public
  clients still need the CA installed, a trusted public certificate, or an
  approved pinning policy.

## Production verdict by component

- **Node.js panel:** production with conditions. The deployed Linux instance
  runs as `betterdesk`, with protected environment secrets and the fixed root
  broker; use a trusted public CA for external clients.
- **Go server:** production with conditions. The deployed `3.5.38` binary uses
  Go `1.26.6`, persistent secrets, authenticated APIs and strict CDAP TLS.
- **Native Linux:** production with conditions. The root maintenance
  migration and systemd verification passed on the operator-provided host;
  disposable lifecycle validation remains.
- **Native Windows:** production with conditions. The Windows path has no
  equivalent sudo boundary, but it still needs isolated installer lifecycle
  validation before a release claim.
- **Docker:** production with conditions. Use reviewed GHCR image tags/digests,
  keep the database volume, and run the exact release runtime smoke test.
- **Tauri agent client and RdClient desktop:** production with conditions after
  rebuilding from this tree; do not use invalid-TLS overrides in production.
- **Native Go agent and support agent:** production with conditions. Require
  WSS/TLS and certificate pinning or a trusted public CA for remote operation.

Overall status: **not “maximum-security” certified yet; production use is
acceptable only under the listed conditions.** The previously confirmed
authentication, path-confinement and Linux privilege-boundary blockers have
been remediated and regression-tested.
