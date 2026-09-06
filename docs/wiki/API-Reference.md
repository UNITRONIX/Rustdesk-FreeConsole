# API Reference

BetterDesk exposes two HTTP APIs on the Go server:

| Port | Role |
|------|------|
| **21114** | Admin REST API (panel, automation; often bound to localhost) |
| **21121** | RustDesk **Client API** (login, address book, heartbeat) |

On some installs the Node console still listens on **21121** as a **compat reverse-proxy** to Go. Handlers live in Go (`client_api_handlers.go`). Point RustDesk **API Server** at `:21121` (with `http://` or `https://`).

---

## Authentication

### API key (server-to-server)

```
X-API-Key: <your-api-key>
```

Used by the panel talking to Go. Key file is typically `/opt/betterdesk/.api_key`.

### JWT (user / client)

```
Authorization: Bearer <jwt-token>
```

From `POST /api/login` on the Client API (`:21121`). Used by Pro users and integrations.

---

## Admin API (port 21114)

Base URL: `http://your-server:21114/api`

### Public (no auth)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/server-config` | Address, public key, version |
| `POST` | `/api/heartbeat` | Client heartbeat |
| `POST` | `/api/sysinfo` | System info upload |
| `POST` | `/api/sysinfo_ver` | Sysinfo hash check |
| `GET` | `/api/server/stats` | Peer counts |

### Devices (API key)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/peers` | List peers |
| `GET` | `/api/peers/{id}` | One peer |
| `PATCH` | `/api/peers/{id}` | Update fields |
| `DELETE` | `/api/peers/{id}` | Soft-delete |
| `DELETE` | `/api/peers/{id}?revoke=true` | Delete + block + disconnect |
| `POST` | `/api/peers/{id}/change-id` | Change device ID |
| `PUT` | `/api/peers/{id}/tags` | Set tags |
| `GET` | `/api/peers/{id}/metrics` | Historical metrics |
| `POST` | `/api/peers/{id}/wol` | Wake-on-LAN |

#### List peers

```bash
curl http://your-server:21114/api/peers \
  -H "X-API-Key: your-api-key"
```

#### Change device ID

```bash
curl -X POST http://your-server:21114/api/peers/1340238749/change-id \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"new_id": "RECEPTION01"}'
```

#### Wake-on-LAN

Body field is **`mac`** (not `mac_address`):

```bash
curl -X POST http://your-server:21114/api/peers/RECEPTION01/wol \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"mac": "AA:BB:CC:DD:EE:FF"}'
```

WoL only reaches hosts on the **same LAN** as the BetterDesk server (magic packet broadcast).

### Config / audit / health

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` / `PUT` | `/api/config/{key}` | Config value |
| `GET` | `/api/audit` | Audit query |
| `POST` | `/api/audit/conn` | Connection audit |
| `GET` | `/api/health` | Health check |

### Address book / policies / CDAP

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` / `POST` | `/api/ab` | Address book |
| `GET` | `/api/ab/personal` | Personal AB |
| `GET` / `POST` / `PUT` / `DELETE` | `/api/access-policies`… | Policy inventory (not enforced on punch) |
| `GET` | `/api/cdap/status` | CDAP gateway |
| `GET` | `/api/cdap/devices` | CDAP devices |
| `POST` | `/api/cdap/devices/{id}/command` | Command to device |

### WebSocket events

```
ws://your-server:21114/api/ws/events?filter=peer_online
```

Filters include `peer_online`, `peer_registered`, `config_changed`.

---

## Client API (port 21121)

Base URL: `http://your-server:21121/api`

RustDesk desktop/mobile use this port for login and AB sync.

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/login` | Login (and TOTP challenge on same endpoint) |
| `GET` | `/api/login-options` | Login methods |
| `POST` | `/api/logout` | Logout |
| `GET` | `/api/currentUser` | Current user |

There is **no** separate `/api/login/2fa` route. When 2FA is required, `/api/login` returns a challenge; send the code back on `/api/login` with the challenge fields (`type` / `code` as the client expects).

#### Login

```bash
curl -X POST http://your-server:21121/api/login \
  -H "Content-Type: application/json" \
  -d '{"username": "operator1", "password": "secret"}'
```

Success returns `access_token`. If 2FA is needed, the response type indicates TOTP — complete login with the code on the same endpoint (stock RustDesk clients handle this UI).

### Also on 21121

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` / `POST` | `/api/ab`… | Address book |
| `GET` | `/api/peers` | Peers (Bearer) |
| `POST` | `/api/heartbeat` | Heartbeat |
| `POST` | `/api/sysinfo` | Sysinfo |
| `POST` | `/api/audit/conn` | Conn audit |

OIDC for desktop clients uses `/api/login-options` and related OIDC paths — see [[OIDC SSO|OIDC-SSO]].

---

## Errors

```json
{ "error": "Error description" }
```

| Code | Meaning |
|------|---------|
| 200 / 201 | OK / created |
| 400 | Bad request |
| 401 / 403 | Auth / role |
| 404 | Missing |
| 429 | Rate limit (`Retry-After`) |
| 500 | Server error |

Login is rate-limited (about 5/min per IP).

---

## See also

- [[User Management|User-Management]]
- [[Unattended Access and WoL|Unattended-and-WoL]]
- [[CDAP]]
- [CDAP API in repo](https://github.com/UNITRONIX/BetterDesk/blob/dev/docs/cdap/API_REFERENCE.md)
