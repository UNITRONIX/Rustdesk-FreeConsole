# Dependency upgrade backlog (non-agent)

Tracked after the July 2026 dependency audit. **Do not** land these majors in the same PR as runtime EOL or patch bumps — one major (or closely related stack) per PR, with full panel/server tests.

Agents (`betterdesk-agent*`) are out of scope until support resumes.

## Deferred majors — `web-nodejs`

| Package | Current | Target | Notes |
|---------|---------|--------|-------|
| express | 4.x | 5.x | Breaking routing / `res.send` signatures; migrate with [Express 5 guide](https://expressjs.com/en/guide/migrating-5/). Likely pulls `path-to-regexp` override rewrite. |
| helmet | 7.x | 8.x | Prefer with Express 5 |
| express-rate-limit | 7.x | 8.x | Prefer with Express 5 |
| csrf-csrf | 3.x | 4.x | Auth/CSRF regression suite |
| bcrypt | 5.x | 6.x | Native rebuild; sheds deprecated `node-gyp` transitive tree |
| better-sqlite3 | **13.x** | — | Done (#353): shared SQLite handles + Node 24 Alpine musl |
| ejs | 3.x | 6.x | Template audit |
| otplib | 12.x | 13.x | **npm-deprecated** at 12; 2FA/TOTP tests required |
| protobufjs | 7.x | 8.x | RdClient / proto paths |
| jest | 29.x | 30.x | Dev/CI only |

## Deferred / blocked — `rdclient-desktop`

| Item | Notes |
|------|-------|
| **RUSTSEC-2024-0429 (glib)** | Ignored in CI/Dependabot until Tauri/GTK stack can move to glib 0.20+. Do not force-upgrade transitive GTK3 crates. |
| Vendored `wry` + git `brotli` patches | Leave until WebView regression testing is scheduled. |

## Done in audit follow-up (2026-07)

- Node **24** (CI/client tooling); production console images temporarily pin Node **22.23.2** because of the Node.js 24 cleanup-hook crash tracked in #377; `engines` **>=22**
- Alpine server runtime **3.22**; Go build image **1.26**
- Patch bumps: axios, nodemailer, ws, pg; Go direct deps including `modernc.org/sqlite`
- SNMP bridge: `pysnmplib` → **`pysnmp` >=7.1**
- Removed orphan `betterdesk-mgmt/package-lock.json`

## Related deferred security (not package majors)

See `docs/security/LOGIN_API_SECURITY_AUDIT_2026-04-26.md`: RustDesk access-token hashing migration; CSP hardening (`unsafe-inline` / `unsafe-eval`).
