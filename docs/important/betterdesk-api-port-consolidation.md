# API port consolidation (Go :21114 + compat proxy :21121)

**Status:** active (v3+)  
**Related:** issue #160, `betterdesk-server/api/*`, `web-nodejs/middleware/goApiProxy.js`

## Summary

| Port | Process | Role |
|------|---------|------|
| **21114** | `betterdesk-server` (Go) | **Default API** — `/api/login`, AB, heartbeat, REST (direct) |
| **21121** | `betterdesk-console` (Node) | **Backward compatibility** — proxy to Go :21114 only |
| **5000** | Node | Admin web panel |

Handlers and database live **only in Go**. Node on **21121** does not implement login/AB logic when `RUSTDESK_API_PROXY=true`.

## Architecture

```
RustDesk client (recommended)  ──HTTP :21114──►  Go  /api/login, /api/ab, …

RustDesk client (legacy URL)   ──HTTP :21121──►  Node (wanSecurity + goApiProxy)
                                                    └──►  Go :21114

Web panel  ── :5000 ──►  betterdeskApi.js  ──►  Go :21114
```

**New deployments:** `http://<host>:21114`  
**Existing fleets (unchanged):** `http://<host>:21121`

## Defaults (.env)

```bash
GO_API_PORT=21114
BETTERDESK_API_URL=http://localhost:21114/api
HBBS_API_URL=http://localhost:21114/api

# Backward compatibility (legacy client configs on :21121)
API_ENABLED=true
API_PORT=21121
RUSTDESK_API_PROXY=true
```

Go systemd: `-api-port 21114`

## Firewall (WAN)

Open **both** for full compatibility:

- **21114/tcp** — default Go API (direct clients)
- **21121/tcp** — legacy proxy entry

## Issue #160

| Symptom | Fix |
|--------|-----|
| Refused on **21114** | Go running, `-api-port 21114`, `ufw allow 21114/tcp` |
| Refused on **21121** | `API_ENABLED=true`, console up, `ufw allow 21121/tcp` |
| Go on **21121**, not 21114 | Repair: Go → 21114, keep proxy on 21121 |

**Linux repair:** `ensure_api_compat_proxy_layout()` → Repair → Services.

## Verification

```bash
curl -sf http://127.0.0.1:21114/api/health
curl -sf http://127.0.0.1:21114/api/login-options
curl -sf http://127.0.0.1:21121/api/login-options
```
