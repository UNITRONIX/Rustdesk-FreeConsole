# Security Policy

> This document describes how to report security vulnerabilities in BetterDesk
> and what to expect from the maintainers in return.

## Supported Versions

Only the latest minor release on the `main` branch receives active security
patches. Older tagged releases may receive backports for critical issues at the
maintainers' discretion.

| Version       | Supported          |
| ------------- | ------------------ |
| `main`        | :white_check_mark: |
| latest tag    | :white_check_mark: |
| older tags    | :x: (best-effort)  |

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security problems.**

Preferred channels (in order):

1. **GitHub Security Advisory (private):**
   <https://github.com/UNITRONIX/Rustdesk-FreeConsole/security/advisories/new>
2. **Encrypted email:** `security@betterdesk.invalid` *(replace with your real
   address before publishing; PGP key TBD)*

Please include, where possible:

- A clear description of the issue and its impact.
- A reproduction recipe (PoC, request/response, or test case).
- Affected versions / commits / deployment shape (Docker single-container,
  multi-container, bare-metal install, etc.).
- Any logs, screenshots or traffic captures \u2014 with sensitive data redacted.

## Response Targets

- **Acknowledgement:** within **7 days** of report.
- **Triage decision:** within **14 days** (severity, scope, fix plan).
- **Coordinated disclosure window:** **90 days** maximum from acknowledgement,
  shortened if the issue is being actively exploited.
- **Credit:** at your option, in the release notes / advisory.

If you do not get an acknowledgement within 7 days, please ping the repository
maintainers via a *public* but vague issue ("waiting on security report
acknowledgement"). Do not disclose any details.

## Scope

In scope:

- The Go server (`betterdesk-server/`) including signal, relay, HTTP/WS API,
  CDAP gateway, BD-MGMT WebSocket, and the database adapters.
- The Node.js web console (`web-nodejs/`) including the RustDesk-compatible
  client API on port `21121`, the panel routes, and the WS push services.
- The Tauri MGMT and Agent clients (`betterdesk-mgmt/`, `betterdesk-agent-client/`).
- The native Go agent (`betterdesk-agent/`).
- The CDAP SDKs and reference bridges (`sdks/`, `bridges/`).
- The ALL-IN-ONE install scripts (`betterdesk.sh`, `betterdesk.ps1`,
  `betterdesk-docker.sh`) and the Docker compose files.

Out of scope:

- Vulnerabilities that require an attacker who already controls the host
  operating system, the database file, or the operator's browser session.
- Findings that only apply to legacy Rust binaries in `archive/` or to forks.
- Denial-of-service from raw network flooding without an amplification vector.
- Self-XSS, missing security headers on documentation pages, or theoretical
  issues without a concrete exploitation path.
- Reports generated solely by automated scanners without manual validation.

## Hardening Defaults

BetterDesk ships with the following defaults that reduce the blast radius of
typical issues. Operators should keep them enabled unless they have a specific
reason to relax them:

- TOTP-based 2FA enforced on the web panel for all roles.
- WebSocket origin allowlist for the API events endpoint (`API_WS_ALLOWED_ORIGINS`).
- `trust proxy` disabled by default; must be opted in explicitly when behind a
  reverse proxy.
- Local-only bind for the panel HTTP port (`HOST=127.0.0.1`); only the
  RustDesk client API (`21121`) is intended for WAN exposure.
- Docker containers run with `no-new-privileges:true` and `cap_drop: [ALL]`.
- Admin password and PostgreSQL password generated with `openssl rand -hex 16`.
- TOTP bypass on the RustDesk client API requires both
  `RUSTDESK_API_DISABLE_TOTP=true` **and**
  `RUSTDESK_API_DISABLE_TOTP_ACKNOWLEDGED=true`, with a startup banner warning.

## Audits

Recent internal audits are published under `docs/security/` (e.g.
`AUDIT_PRODUCTION_2026-04-10.md`). Fixes are referenced in commit messages and
in `.github/copilot-instructions.md` under the relevant Phase.

---

*This policy was last updated on 2026-04-10.*
