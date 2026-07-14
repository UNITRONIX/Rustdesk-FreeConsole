# FAQ

Frequently asked questions about BetterDesk.

---

## General

### What is BetterDesk?

BetterDesk is a complete RustDesk-compatible remote desktop infrastructure. It replaces the original RustDesk `hbbs` + `hbbr` servers with a single Go binary, adds a Node.js web management console, desktop clients, and an IoT device management protocol (CDAP).

### Is BetterDesk compatible with RustDesk clients?

Yes. BetterDesk is fully compatible with standard RustDesk desktop and mobile clients. No custom client required — just point your existing RustDesk client to your BetterDesk server.

### What's the difference between BetterDesk and RustDesk Server Pro?

BetterDesk is an independent, open-source project that provides features beyond the RustDesk OSS server:
- Web management console with dashboard
- RBAC with 6–7 server roles + organizations and 28 granular permissions
- TOTP 2FA
- E2E encrypted chat
- Browser-based remote desktop
- Device metrics and monitoring
- CDAP IoT protocol
- PostgreSQL support
- Docker single-container deployment
- Desktop widget dashboard

### Is it free?

Yes. BetterDesk is licensed under **AGPL-3.0**. You may use it freely; if you modify and run it as a network service, AGPL copyleft applies to those modifications. Sponsors at **$50/month+** on [GitHub Sponsors](https://github.com/sponsors/UNITRONIX) may qualify for an optional **Commercial Grant** for private deployment patches — see [[Licensing]].

---

## Installation

### What are the minimum server requirements?

- **CPU:** 1 core (2+ recommended)
- **RAM:** 512 MB (2 GB recommended)
- **Disk:** 1 GB
- **OS:** Ubuntu 20.04+, Debian 11+, CentOS 8+, Windows 10/11, or Docker

### Which ports need to be open?

| Port | Protocol | Required |
|------|----------|----------|
| 21116 | TCP + UDP | ✅ Signal server |
| 21117 | TCP | ✅ Relay server |
| 21114 | TCP | ⚠️ API (internal, can be localhost) |
| 21115 | TCP | ⚠️ NAT test |
| 21118 | TCP | Optional (WS signal) |
| 21119 | TCP | Optional (WS relay) |
| 21121 | TCP | ✅ Client API (if clients login) |
| 5000 | TCP | ✅ Web console |
| 21122 | TCP | Optional (CDAP gateway) |

### Can I run it behind a NAT/firewall?

Yes, but the relay server IP must be public (or port-forwarded). Set `RELAY_SERVERS=YOUR.PUBLIC.IP` if auto-detection fails.

### Does it work on ARM (Raspberry Pi)?

Yes. The Go server compiles for `linux/arm64`:
```bash
GOARCH=arm64 go build -o betterdesk-server-linux-arm64 .
```

Docker images are also built for `linux/arm64`.

---

## Configuration

### How do I change the admin password?

```bash
# Linux
sudo ./betterdesk.sh   # Choose option 6

# Windows
.\betterdesk.ps1       # Choose option 6

# Manual
cd /opt/BetterDeskConsole && node reset-password.js
```

### How do I switch from SQLite to PostgreSQL?

```bash
sudo ./betterdesk.sh
# Choose option M → SQLite to PostgreSQL
```

Or manually:
```bash
./tools/migrate/migrate-linux-amd64 -mode sqlite2pg \
  -src db_v2.sqlite3 \
  -dst "postgres://user:pass@localhost:5432/betterdesk"
```

Then update `.env`:
```env
DB_TYPE=postgresql
DATABASE_URL=postgres://user:pass@localhost:5432/betterdesk
```

### How do I set up TLS/SSL?

```bash
sudo ./betterdesk.sh
# Choose option C — SSL Configuration
```

See [[TLS / SSL Certificates|TLS-SSL]] for details.

### Can I use a reverse proxy?

Yes. See [External Reverse Proxy Guide](../setup/REVERSE_PROXY.md) and [[Configuration]] for Nginx/Caddy examples. Set **`TRUST_PROXY=Y`** (or `1`) in `.env` and `HOST=127.0.0.1` when TLS terminates at the proxy.

---

## Devices

### Why do devices show as offline?

Most common causes:
1. Firewall blocking ports 21116/21117
2. Wrong server address in client config
3. Public key mismatch
4. Go server not running

Run diagnostics: `sudo ./betterdesk.sh` → option 8.

### How do I rename a device ID?

From the web console:
1. Click the kebab menu (⋮) on the device
2. Select **Rename**
3. Enter new ID (6-16 characters, alphanumeric + dash/underscore)

Via API:
```bash
curl -X POST http://server:21114/api/peers/OLD_ID/change-id \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"new_id": "NEW_ID"}'
```

### What happens when I delete a device?

Soft-delete: device is marked as deleted, cannot re-register, filtered from lists. The record remains in the database for audit purposes.

With `?revoke=true`: additionally blocks the device ID and disconnects active sessions. The device can never reconnect with that ID.

### How do I wake a device remotely?

The device must have a known MAC address. From the web console, click the kebab menu → **Wake on LAN** on an offline device. Or via API:

```bash
curl -X POST http://server:21114/api/peers/DEVICE_ID/wol \
  -H "X-API-Key: your-key" \
  -d '{"mac_address": "AA:BB:CC:DD:EE:FF"}'
```

WOL sends a UDP magic packet on broadcast (255.255.255.255:9). Only works on the same LAN segment as the server.

---

## Security

### Is the connection encrypted?

Yes, at multiple layers:
1. **NaCl encryption** — Signal protocol uses Ed25519 key exchange
2. **E2E encryption** — Peer-to-peer traffic is encrypted end-to-end
3. **TLS** — Optional TLS wrapping for all TCP connections
4. **Chat E2E** — ECDH P-256 + AES-256-GCM for chat messages

### Can the server read my remote desktop stream?

No. The relay server performs blind `io.Copy` between two TCP connections. Peers negotiate E2E encryption through the signal channel — the server cannot decrypt the video/audio/input stream.

### How are passwords stored?

- User passwords: bcrypt with automatic salt
- Device passwords: bcrypt via access policies
- API keys: stored as plaintext in `.api_key` file

### Is 2FA supported?

Yes. TOTP (Time-based One-Time Password) compatible with Google Authenticator, Authy, etc. See [[User Management|User-Management]].

---

## Performance

### How many devices can BetterDesk support?

Depends on server resources:
- **100 devices:** 1 CPU, 512 MB RAM
- **1,000 devices:** 2 CPUs, 2 GB RAM
- **10,000+ devices:** 4+ CPUs, 4+ GB RAM, PostgreSQL recommended

### Does the relay server use a lot of bandwidth?

The relay proxies peer-to-peer traffic via `io.Copy`. Each active remote desktop session uses 1-10 Mbps depending on resolution and quality settings. Idle/registered devices use minimal bandwidth (heartbeat only).

### SQLite vs PostgreSQL — which should I use?

- **SQLite** — Good for up to ~1,000 devices. Zero configuration, single file.
- **PostgreSQL** — Recommended for 1,000+ devices. Better concurrent access, `LISTEN/NOTIFY` for multi-instance, connection pooling.

---

## Upgrading

### Will updating break my setup?

No. The v2.4.0+ update process:
- Preserves database files
- Preserves PostgreSQL configuration
- Preserves SSL certificates
- Preserves API keys and admin credentials
- Preserves auth.db (user accounts, TOTP)

### How do I update?

**Native install:**
```bash
git pull
sudo ./betterdesk.sh   # Choose option 2 — Update
```

Or use **Settings → Updates** in the web panel (recommended — includes backup and preflight checks). See [[Panel Updates|Panel-Updates]].

**Docker (GHCR images):**
```bash
docker compose pull && docker compose up -d
```

### Can I downgrade?

Create a backup before updating (`option 5`), then restore from backup if needed. Database schema changes may not be backward-compatible.

---

## CDAP

### What is CDAP?

Connected Device Automation Protocol — BetterDesk's WebSocket protocol for managing IoT devices, servers, and custom hardware. Provides telemetry, widget rendering, remote commands, terminal, and file management.

### Do I need CDAP?

Only if you want to manage non-RustDesk devices (sensors, servers, industrial equipment). Standard RustDesk remote desktop works without CDAP.

### How do I connect a device via CDAP?

Use the Python or Node.js SDK, or the native Go agent:
```bash
betterdesk-agent -server ws://your-server:21122/cdap -api-key your-key
```

See [[CDAP]] for the full protocol specification.

---

## Contributing

### How do I add a new language?

1. Copy `web-nodejs/lang/en.json` to `web-nodejs/lang/{code}.json`
2. Translate all values
3. The language auto-appears in the console

### Where do I report bugs?

[GitHub Issues](https://github.com/UNITRONIX/BetterDesk/issues)

### Can I contribute code?

Yes! Pull requests are welcome. Follow the coding style and conventions described in the repository.

---

## Organizations & SSO

### What are organizations?

Organizations let you scope devices and users for multi-team or MSP deployments. Org admins manage members within their org; global admins manage all orgs. See [[Organizations and RBAC|Organizations-and-RBAC]].

### Can I use Azure AD / Okta / Google login?

Yes. Configure **OIDC / OAuth2** under **Settings → Authentication**. See [[OIDC SSO|OIDC-SSO]].

### Why do RustDesk clients disconnect after ~24 hours?

Fixed in v3.3.129+: client sessions are DB-backed (7-day sliding, 30-day max). Update the server, then sign in once in the RustDesk client. Configure TTL under **Settings → Authentication → RustDesk clients**.

---

## See also

- [[Troubleshooting]] — common fixes
- [[Licensing]] — AGPL and Commercial Grant
- [[Panel Updates|Panel-Updates]] — update channels (stable / dev)
