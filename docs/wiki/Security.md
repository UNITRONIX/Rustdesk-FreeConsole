# Security

BetterDesk implements defense-in-depth security across all layers. Software is distributed under **AGPL-3.0** — see [[Licensing]]. Panel operators can enable **OIDC/SSO** — see [[OIDC SSO|OIDC-SSO]].

---

## Encryption

### Signal Protocol (NaCl)

Client-server communication on the signal port (21116 TCP) uses NaCl (Networking and Cryptography Library):

1. Server generates Ed25519 key pair on first start (`id_ed25519`, `id_ed25519.pub`)
2. Client connects and performs Diffie-Hellman key exchange
3. All subsequent messages are encrypted with the shared session key
4. Peers identify each other via public key verification

### Relay Encryption

Relay connections (port 21117) carry encrypted peer-to-peer traffic:
- Peers establish E2E encryption through the signal channel
- Relay server performs blind `io.Copy` — it cannot decrypt traffic
- UUID pairing ensures both peers connect to the same relay session

### TLS Transport

Optional TLS wrapping for all TCP connections:
- **Signal TLS** (`--tls-signal`) — Encrypts signal port 21116
- **Relay TLS** (`--tls-relay`) — Encrypts relay port 21117
- **API TLS** (`--tls-api`) — HTTPS on API port 21114
- **WSS** — WebSocket Secure on ports 21118, 21119
- **Dual-mode listener** — Auto-detects TLS (first byte `0x16`) vs plain TCP on same port

See [[TLS / SSL Certificates|TLS-SSL]] for certificate configuration.

### Chat E2E Encryption

See [[Chat E2E Encryption|Chat-E2E]] for the chat-specific encryption protocol.

---

## Authentication

### Web Console

| Mechanism | Description |
|-----------|-------------|
| **Session cookies** | `HttpOnly`, `Secure`, `SameSite=Lax` |
| **Session regeneration** | New session ID after login (prevents fixation) |
| **Bcrypt passwords** | Automatic salt, timing-safe comparison |
| **TOTP 2FA** | 30-second TOTP with one-window tolerance |
| **Partial 2FA token** | 5-minute TTL JWT for 2FA step |

### API Authentication

| Method | Usage |
|--------|-------|
| **API Key** (`X-API-Key` header) | Server-to-server (Node.js ↔ Go) |
| **JWT Bearer** (`Authorization: Bearer` header) | User API access (Pro/Admin/Operator) |
| **Session cookie** | Web panel requests |

### RustDesk Client Auth

| Method | Description |
|--------|-------------|
| **Public key** | Ed25519 key exchange on signal connection |
| **Registration token** | Optional token required for client registration |
| **User login** | Username/password via `/api/login` on Client API (port 21121) |

---

## Authorization (RBAC)

Four-tier role-based access control:

| Role | Panel | API | Devices | Users | Settings |
|------|-------|-----|---------|-------|----------|
| **Admin** | ✅ | ✅ | Full | Full | Full |
| **Operator** | ✅ | ✅ | View + Connect | ❌ | ❌ |
| **Viewer** | ✅ | Read | View only | ❌ | ❌ |
| **Pro** | ❌ | ✅ | Full API | ❌ | ❌ |

See [[User Management|User-Management]] for details.

---

## Rate Limiting

### IP-Based Limits

| Endpoint | Limit | Description |
|----------|-------|-------------|
| `POST /api/auth/login` | 5/min per IP | Login attempts |
| `POST /api/auth/login/2fa` | 5/min per IP | TOTP verification |
| TCP signal connections | Configurable | Per-IP connection rate |
| WebSocket upgrades | Per-IP | Signal and relay |

### Connection Limits

| Resource | Limit | Description |
|----------|-------|-------------|
| TCP punch connections | 10,000 max, 2-min TTL | DDoS protection |
| Relay sessions | Idle timeout (configurable) | Stale session cleanup |
| API WebSocket | Per-IP | Event stream connections |

---

## Input Validation

### API Endpoints

| Validation | Rule |
|-----------|------|
| **Peer ID** | Alphanumeric, 1-32 characters |
| **New peer ID** (rename) | `[A-Za-z0-9_-]{6,16}` |
| **Config keys** | `[a-zA-Z0-9._-]{1,64}` |
| **SQL LIKE patterns** | `%` and `_` escaped with `\` |
| **Tags** | String or JSON array accepted |
| **Device IDs** | Coerced to string (numeric accepted) |

### WebSocket

| Check | Description |
|-------|-------------|
| **Origin validation** | `WS_ALLOWED_ORIGINS` env var (signal + relay) |
| **API origin validation** | `API_WS_ALLOWED_ORIGINS` env var |
| **Session required** | WebSocket upgrade requires valid session cookie |

---

## CSRF Protection

The web console uses double-submit cookie pattern:
- CSRF token generated per session
- Token included in forms and AJAX requests
- Server validates token against cookie
- Implemented via `csrf-csrf` middleware

---

## Audit Logging

All security-relevant events are logged:

| Event | Details Logged |
|-------|---------------|
| Login success/failure | IP, user agent, username |
| 2FA attempts | IP, success/failure |
| Password changes | User, IP |
| Device ban/unban | Device ID, admin |
| Device deletion | Device ID, admin, revoke flag |
| API key usage | Key ID, endpoint |
| Config changes | Key, old/new values |
| Sysinfo updates | Device ID, hostname, OS |
| Connection audit | Host ID, peer ID, action, IP |

Audit entries are stored in the Go server's ring buffer and queryable via API.

---

## Device Security

### Soft Delete

Deleted devices are soft-deleted (marked `soft_deleted=1`). They:
- Cannot re-register on the signal server
- Are filtered from device list queries
- Prevent "zombie device" reappearance

### Device Revocation

The `?revoke=true` flag on device deletion:
1. Soft-deletes the device
2. Blocks the device ID (`IsPeerBanned`)
3. Disconnects all active TCP and WebSocket connections
4. Logs `ActionPeerRevoked` audit entry
5. Optionally cascades to linked devices (`?cascade=true`)

### Peer Banning

Banned devices:
- Cannot register on the signal server
- Cannot establish relay connections
- Ban is per-device-ID (not per-IP)

---

## Dependency Security

### Node.js Console

- `npm audit --omit=dev` reports **0 vulnerabilities**
- `tar` package overridden for CVE fix
- Dependencies pinned via `package-lock.json`

### Go Server

- Go toolchain version pinned in `go.mod`
- No CGO dependencies (static binary)
- Minimal external dependencies

---

## Security Headers

The web console sets standard security headers:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Content-Security-Policy` (configured per environment)

---

## See also

- [[TLS / SSL Certificates|TLS-SSL]] — transport encryption
- [[Chat E2E Encryption|Chat-E2E]] — operator chat crypto
- [[User Management|User-Management]] — 2FA and sessions
- [[Licensing]] — AGPL and Commercial Grant
