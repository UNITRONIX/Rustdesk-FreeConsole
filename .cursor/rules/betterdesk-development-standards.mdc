---
description: Core BetterDesk development standards — updates, safety, testing, and issue replies
alwaysApply: true
---

# BetterDesk development standards

## 1. Updates must be deployable in production

Every fix must be applicable through the **built-in update module** in the web-nodejs panel (`updateService.js`, Settings → Updates) or via **`betterdesk.sh` / `betterdesk.ps1`**.

Before merging changes that touch deployment:

- Prefer paths under `web-nodejs/`, `betterdesk-server/`, and tracked root scripts — these are auto-applied by the panel updater.
- **`.env` changes:** append missing keys only via `envMerge.js` / `buildEnvSubstitutions()` — never overwrite operator secrets or DB passwords.
- **DB schema / permissions / new system users:** design migrations so the panel update or install script applies them automatically. If that is impossible, create a release whose notes clearly state that a **manual script step** is required (e.g. new OS user, new file permissions, systemd/NSSM unit changes).
- Read `docs/important/betterdesk-update-flow.md` when changing update, installer, or service-definition behaviour.

## 2. Security, quality, and performance

Changes must not introduce unsafe behaviour. Before finishing work:

- Run relevant tests: `web-nodejs` → `npm test`; Go packages → `go test ./...` in the affected module.
- Pay special attention to auth, SSRF, input validation, rate limits, and WebSocket/relay security — matching existing test patterns in `web-nodejs/tests/` and `betterdesk-server/`.
- Avoid regressions in update flow, env merge, and service restart logic.
- Do not add unnecessary complexity, broad error swallowing, or performance-heavy hot paths without justification.

## 3. Protect the test server and database

The SSH test instance and its database must **not** be broken by changes.

- Treat production-like data as fragile: no destructive migrations without rollback, no blind schema drops, no password resets via updates.
- If a change causes an outage on test: analyse the full failure (logs, update SHA, service state, DB), prepare a targeted patch, and restore the instance to a working state before considering the task done.
- Prefer reversible changes and pre-update backups (the panel updater creates these by default).

### Production SSH (operator private — not for GitHub issue reporters)

The operator’s **production** BetterDesk host is reachable by SSH **only from the maintainer’s environment** (Cursor agent / operator LAN). **Do not** share SSH credentials, hostnames, or deploy commands with GitHub issue reporters — they verify fixes via public API URL and client retest only.

## 4. GitHub issue replies

When responding to GitHub issues, write in **English**.

- Keep replies **short, direct, and human** — a few sentences unless the reporter clearly wants a deep dive.
- State what was wrong, what you changed (or what you need from them), and how to verify — without long essays or boilerplate.
