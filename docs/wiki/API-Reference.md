# API Reference

BetterDesk exposes two HTTP APIs: the **Go Server API** (port 21114) and the **Node.js Client API** (port 21121).

---

## Authentication

### API Key (Server-to-Server)

```
X-API-Key: <your-api-key>
```

Used by the Node.js console to communicate with the Go server. The API key is stored in `/opt/betterdesk/.api_key`.

### JWT Bearer (User API)

```
Authorization: Bearer <jwt-token>
```

Obtained via `POST /api/login` on the Client API (port 21121). Used by Pro users and automated integrations.

---

## Go Server API (Port 21114)

Base URL: `http://your-server:21114/api`

### Public Endpoints (No Auth Required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/server-config` | Server address, public key, version |
| `POST` | `/api/heartbeat` | Client heartbeat with CPU/memory/disk metrics |
| `POST` | `/api/sysinfo` | Client system info upload (hostname, OS, version) |
| `POST` | `/api/sysinfo_ver` | Sysinfo version check (SHA256 hash) |
| `GET` | `/api/server/stats` | Total/online peer counts |

### Device Management (API Key Required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/peers` | List all peers with live status |
| `GET` | `/api/peers/{id}` | Get single peer with live status |
| `PATCH` | `/api/peers/{id}` | Update peer fields (note, user, tags) |
| `DELETE` | `/api/peers/{id}` | Delete peer (soft-delete) |
| `DELETE` | `/api/peers/{id}?revoke=true` | Revoke: delete + block + disconnect |
| `DELETE` | `/api/peers/{id}?cascade=true` | Delete with linked devices |
| `POST` | `/api/peers/{id}/change-id` | Change device ID |
| `PUT` | `/api/peers/{id}/tags` | Set peer tags |
| `GET` | `/api/peers/stats` | Detailed peer statistics |
| `GET` | `/api/peers/{id}/metrics` | Historical metrics (CPU/memory/disk) |
| `POST` | `/api/peers/{id}/wol` | Send Wake-on-LAN magic packet |

#### List Peers (Example)

```bash
curl http://your-server:21114/api/peers \
  -H "X-API-Key: your-api-key"
```

**Response:**

```json
[
  {
    "id": "1340238749",
    "uuid": "a1b2c3d4-...",
    "hostname": "DESKTOP-ABC",
    "platform": "Windows 11",
    "version": "1.3.1",
    "ip": "192.168.1.100",
    "status": 1,
    "live_online": true,
    "live_status": "ONLINE",
    "last_online": "2026-03-27T12:00:00Z",
    "note": "Reception desk",
    "tags": "office,floor1",
    "device_type": "",
    "linked_peer_id": ""
  }
]
```

#### Change Device ID

```bash
curl -X POST http://your-server:21114/api/peers/1340238749/change-id \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"new_id": "RECEPTION01"}'
```

#### Wake-on-LAN

```bash
curl -X POST http://your-server:21114/api/peers/RECEPTION01/wol \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"mac_address": "AA:BB:CC:DD:EE:FF"}'
```

### Configuration

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/config/{key}` | Get config value |
| `PUT` | `/api/config/{key}` | Set config value |

### Audit

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/audit` | Query audit log entries |
| `POST` | `/api/audit/conn` | Log connection audit event |

### Server Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Server health check |

### Address Book

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/ab` | Get user address book |
| `POST` | `/api/ab` | Save user address book |
| `GET` | `/api/ab/personal` | Get personal AB |
| `GET` | `/api/ab/tags` | Get AB tags |

### Access Policies

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/access-policies` | List all access policies |
| `GET` | `/api/access-policies/{id}` | Get single policy |
| `POST` | `/api/access-policies` | Create access policy |
| `PUT` | `/api/access-policies/{id}` | Update access policy |
| `DELETE` | `/api/access-policies/{id}` | Delete access policy |

#### Access Policy Schema

```json
{
  "id": 1,
  "peer_id": "RECEPTION01",
  "password_hash": "$2a$10$...",
  "permanent_password": true,
  "allowed_operators": ["admin", "operator1"],
  "schedule": {
    "days": ["monday", "tuesday", "wednesday", "thursday", "friday"],
    "start_time": "08:00",
    "end_time": "18:00",
    "timezone": "Europe/Warsaw"
  },
  "enabled": true,
  "created_at": "2026-03-27T12:00:00Z"
}
```

### RustDesk Client Compatibility

These endpoints mirror the standard RustDesk server API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/login` | Client login (username/password) |
| `GET` | `/api/login-options` | Available login methods |
| `POST` | `/api/logout` | Client logout |
| `GET` | `/api/currentUser` | Current authenticated user info |

### CDAP Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/cdap/status` | CDAP gateway status |
| `GET` | `/api/cdap/devices` | List connected CDAP devices |
| `GET` | `/api/cdap/devices/{id}/info` | Device info (type, version, uptime) |
| `GET` | `/api/cdap/devices/{id}/manifest` | Device widget manifest |
| `GET` | `/api/cdap/devices/{id}/state` | Current widget state values |
| `POST` | `/api/cdap/devices/{id}/command` | Send command to device |

### WebSocket Events

```
ws://your-server:21114/api/ws/events?filter=peer_online
```

Real-time event stream. Supported filters:
- `peer_online` — Device online/offline status changes
- `peer_registered` — New device registration
- `config_changed` — Configuration updates

---

## Node.js Client API (Port 21121)

Base URL: `http://your-server:21121/api`

This API serves RustDesk desktop/mobile clients on a dedicated WAN-facing port with 7-layer security.

### Authentication Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/login` | Client login |
| `POST` | `/api/login/2fa` | TOTP verification |
| `GET` | `/api/login-options` | Login method options |
| `POST` | `/api/logout` | Client logout |
| `GET` | `/api/currentUser` | Current user info |

#### Login

```bash
curl -X POST http://your-server:21121/api/login \
  -H "Content-Type: application/json" \
  -d '{"username": "operator1", "password": "secret"}'
```

**Response (success):**

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "type": "access_token",
  "user": {
    "name": "operator1",
    "role": "operator"
  }
}
```

**Response (2FA required):**

```json
{
  "type": "2fa_required",
  "tfa_type": "totp",
  "access_token": "partial_token_here"
}
```

### Address Book

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/ab` | Get address book |
| `POST` | `/api/ab` | Save address book |
| `GET` | `/api/ab/personal` | Get personal AB |
| `GET` | `/api/ab/tags` | Get AB tags |

### Device Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/peers` | List peers (with Bearer token) |
| `GET` | `/api/users` | List users (with Bearer token) |

### Heartbeat & Sysinfo

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/heartbeat` | Device heartbeat |
| `POST` | `/api/sysinfo` | System information update |
| `POST` | `/api/audit/conn` | Connection audit log |

---

## Error Responses

### Standard Error Format

```json
{
  "error": "Error description"
}
```

### HTTP Status Codes

| Code | Description |
|------|-------------|
| `200` | Success |
| `201` | Created |
| `400` | Bad request (validation error) |
| `401` | Unauthorized (missing/invalid auth) |
| `403` | Forbidden (insufficient role) |
| `404` | Resource not found |
| `429` | Rate limit exceeded |
| `500` | Internal server error |

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| `POST /api/login` | 5 requests/minute per IP |
| `POST /api/login/2fa` | 5 requests/minute per IP |
| Other endpoints | No limit (API key/JWT required) |

The `429` response includes `Retry-After` header indicating seconds to wait.

---

## See also

- [[User Management|User-Management]] — Pro user JWT auth
- [[Organizations and RBAC|Organizations-and-RBAC]] — org-scoped endpoints
- [[CDAP]] — CDAP gateway API
- [API docs in repo](https://github.com/UNITRONIX/BetterDesk/tree/main/docs/cdap/API_REFERENCE.md)
