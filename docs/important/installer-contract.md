# BetterDesk installer contract

This document defines the supported lifecycle contract for BetterDesk
installation paths. The contract is intentionally platform-neutral; each
installer may use native service tooling, but must provide the same observable
result.

## Supported entry points

| Path | Runtime | Scope |
|---|---|---|
| `install.sh` | Linux | Docker quick install, native bootstrap, Docker rescue/uninstall |
| `betterdesk.sh` | Linux | Native server and console lifecycle manager |
| `betterdesk.ps1` | Windows | Native server and console lifecycle manager |
| `betterdesk-docker.sh` | Linux + Docker | Compose lifecycle, rescue, migration and diagnostics |
| `betterdesk-agent/install/install.sh` | Linux | Native agent install/uninstall |
| `betterdesk-agent/install/install.ps1` | Windows | Native agent install/uninstall |
| `betterdesk-support-agent/install.go` | Linux, Windows, macOS | Support-agent self-install/uninstall |
| `scripts/installer-protocol-check.js` | Linux, Windows, Docker | Shared HTTP/HTTPS, redirect, SAN and TCP verification |

`install.sh` embeds `BETTERDESK_INSTALLER_CHANNEL` so a one-line install from
`.../dev/install.sh` clones `dev` and `.../main/install.sh` clones `main`.
When releasing this file onto `main`, set that channel to `main` (operators can
still override with `--branch` / `BETTERDESK_BRANCH`).

The `build-betterdesk.*` wrappers and `betterdesk-server/deploy.sh` are
development or migration tools. They must not silently replace the official
installer lifecycle or be presented as the primary production installation
path.

## Lifecycle guarantees

Every official installer must implement or explicitly reject these operations
with a clear message and non-zero exit code:

1. **Preflight** — verify platform, privilege, dependencies, writable paths,
   available disk space, required ports, network access and compatible version.
2. **Fresh install** — create only the required directories and services,
   preserve operator-supplied secrets, initialize the selected database and
   finish with a health check.
3. **Update** — download a complete, validated source/image, preserve runtime
   state, apply migrations, deploy writable binaries atomically, restart
   affected services and write the commit/version marker only after
   verification. Root-owned Linux systemd units and Go binaries require the
   documented root maintenance/deploy step; the panel must not sudo mutable
   repository scripts.
4. **Repair** — restore missing binaries, dependencies, permissions, service
   definitions and TLS material without requiring legacy RustDesk artifacts for
   the Go deployment.
5. **Validate/diagnose** — report actionable errors and warnings without
   changing data in read-only diagnostic mode.
6. **Backup and restore** — include the database, keys, `.env` and other
   runtime credentials; restore must validate the backup manifest before
   writing files.
7. **Uninstall** — stop and remove all service variants created by the
   installer. Default uninstall preserves data; an explicit purge may remove
   data, volumes and generated firewall rules.
8. **Reinstall** — be safe after a non-purge uninstall and preserve state when
   the operator chooses to keep it.

## Completion criteria

An operation is successful only when all of the following are true:

- the process exits with code `0`;
- the installed product version and update SHA describe the deployed code;
- required services are running under the intended account;
- configured HTTP/API/TLS health checks pass;
- database, key material and operator configuration remain usable;
- a repeated invocation does not duplicate services, rules, files or data;
- failures leave the previous binary/configuration usable or provide a
  verified rollback path.

An update must not advance `.update_sha`, `.agent_source_sha` or clear a
previous failure marker while a critical source, binary, migration or service
step is incomplete.

## Platform-specific endpoints

- Native Linux and Windows: panel health on the configured HTTP/HTTPS port,
  Go API on `21114`, client API on `21121`, and signal/relay listeners as
  configured.
- Docker single layout: Go/client API on `21121` and console on `5000`.
- Docker split layout: Go API on `21114` and console on `5000`.

The protocol verification must distinguish a successful TCP listener from a
successful HTTP response and, for HTTPS, a valid certificate/SAN and TLS
handshake.

## Safety rules

- Never overwrite existing `.env` secrets with template values.
- Never remove database, keys, volumes or firewall rules without explicit
  confirmation or a purge flag.
- Never require `hbbs`, `hbbr` or `hbbs-patch-v2` to repair a Go
  `betterdesk-server` installation.
- Never grant sudoers permission to execute a mutable repository script as
  root. Linux panel restarts use only the fixed root-owned
  `betterdesk-privileged-update.js` broker with an allowlisted action set.
- Never report success after a partial update merely because the process
  restarted.
