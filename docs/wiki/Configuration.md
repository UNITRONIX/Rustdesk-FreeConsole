# Configuration

BetterDesk is configured through **CLI flags**, **environment variables**, and **`.env` files**.

---

## Go Server Configuration

### CLI Flags

```bash
betterdesk-server [flags]

  -port int        Signal server port (default 21116)
  -relay-port int  Relay server port (default 21117)
  -key string      Ed25519 key file path (default "id_ed25519")
  -db string       Database path or DSN (default "db_v2.sqlite3")

  -relay-servers string     Comma-separated relay servers (e.g., "1.2.3.4:21117")
  -always-use-relay         Force all connections through relay
  -register-require-token   Require token for client registration
  -register-token string    Registration token value

  -tls-cert string   TLS certificate file path
  -tls-key string    TLS private key file path
  -tls-signal        Enable TLS on signal port (21116)
  -tls-relay         Enable TLS on relay port (21117)
  -tls-api           Enable TLS on API port (21114)
  -force-https       Force HTTPS redirects (implies --tls-api)

  -cdap              Enable CDAP gateway (:21122)
  -metrics           Enable Prometheus metrics endpoint
  -admin-port int    TCP admin console port (disabled by default)
  -log-format string Log format: text or json (default "text")
  -log-level string  Log level: debug, info, warn, error (default "info")
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` / `SIGNAL_PORT` | `21116` | Signal server port |
| `RELAY_PORT` | `21117` | Relay server port |
| `API_PORT` | signal-2 (21114) | HTTP API port |
| `DB_URL` | `db_v2.sqlite3` | Database path or PostgreSQL DSN |
| `RELAY_SERVERS` | auto-detected | Comma-separated relay addresses |
| `ALWAYS_USE_RELAY` | `N` | Force relay for all connections |
| `REGISTER_REQUIRE_TOKEN` | `N` | Require registration token |
| `REGISTER_TOKEN` | (empty) | Registration token value |
| `TLS_SIGNAL` | `N` | Enable TLS on signal |
| `TLS_RELAY` | `N` | Enable TLS on relay |
| `TLS_API` | `N` | Enable TLS on API |
| `TLS_CERT` | (empty) | TLS certificate file path |
| `TLS_KEY` | (empty) | TLS private key file path |
| `WS_ALLOWED_ORIGINS` | `*` | WebSocket signal/relay origin allowlist |
| `API_WS_ALLOWED_ORIGINS` | `*` | API WebSocket origin allowlist |
| `CDAP_ENABLED` | `N` | Enable CDAP gateway |
| `API_KEY` | (auto-generated) | API authentication key |

---

## Node.js Console Configuration

The Node.js console is configured through `/opt/BetterDeskConsole/.env`:

```env
# Server Connection
BETTERDESK_API_URL=http://localhost:21114/api
API_KEY=<your-api-key>

# Web Console
PORT=5000
HOST=127.0.0.1           # Panel bind address (LAN-only by default)
SESSION_SECRET=<random>

# RustDesk Client API
CLIENT_API_PORT=21121
API_HOST=0.0.0.0          # Client API bind address (WAN-facing)

# Database
DB_TYPE=sqlite             # sqlite or postgresql
DATABASE_URL=              # PostgreSQL DSN (required when DB_TYPE=postgresql)

# Security
TRUST_PROXY=false          # Set true behind reverse proxy
STORE_ADMIN_CREDENTIALS=false  # Persist admin credentials to file

# Chat
CHAT_ENABLED=true
CHAT_PORT=21130
CHAT_MAX_FILE_SIZE=52428800  # 50 MB

# Optional
NODE_ENV=production
LOG_LEVEL=info
```

### Important Settings

#### `HOST` vs `API_HOST`

- `HOST` (default `127.0.0.1`) — Binds the web panel. Default is localhost-only for security. Set to `0.0.0.0` to expose the panel to the network (use with reverse proxy + TLS).
- `API_HOST` (default `0.0.0.0`) — Binds the RustDesk Client API (port 21121). Must be WAN-accessible for client login, AB sync, and heartbeat.

#### `TRUST_PROXY`

Set to `true` if running behind a reverse proxy (nginx, Caddy, Cloudflare). This enables:
- Reading `X-Forwarded-For` for real client IPs in rate limiting
- Proper `req.protocol` detection for secure cookies

> [!NOTE]
> UDP/TCP signal on port **21116** cannot use HTTP headers like `X-Forwarded-For`. `TRUST_PROXY` applies to HTTP/API traffic only.

#### `GO_API_PORT` vs `API_PORT`

When both Go server and Node.js console share `.env`:
- **`GO_API_PORT=21114`** — Go REST API (used by panel proxy)
- **`API_PORT` / `CLIENT_API_PORT=21121`** — RustDesk Client API (Node.js)

The installer sets `GO_API_PORT=21114` on `betterdesk-server.service` to avoid HTTP/HTTPS toggle conflicts (#219).

#### Update channel

```env
UPDATE_GITHUB_BRANCH=main   # stable (default) or dev
```

Switch in **Settings → Updates → Update channel**. See [[Panel Updates|Panel-Updates]].

## Ports Reference

| Port | Protocol | Service | Description |
|------|----------|---------|-------------|
| 21114 | TCP (HTTP) | Go API | REST API + WebSocket events |
| 21115 | TCP | NAT Test | `TestNatRequest`, `OnlineRequest` |
| 21116 | TCP + UDP | Signal | Client registration, punch hole |
| 21117 | TCP | Relay | Bidirectional stream relay |
| 21118 | WS | WS Signal | WebSocket signal (21116 + 2) |
| 21119 | WS | WS Relay | WebSocket relay (21117 + 2) |
| 21121 | TCP (HTTP) | Client API | RustDesk Client API (Node.js) |
| 21122 | WS | CDAP | CDAP WebSocket gateway |
| 5000 | TCP (HTTP) | Web Console | Admin/operator panel |

### Firewall Configuration

```bash
# Linux (ufw)
sudo ufw allow 21114:21119/tcp
sudo ufw allow 21116/udp
sudo ufw allow 21121/tcp
sudo ufw allow 5000/tcp

# Linux (firewalld)
sudo firewall-cmd --permanent --add-port=21114-21119/tcp
sudo firewall-cmd --permanent --add-port=21116/udp
sudo firewall-cmd --permanent --add-port=21121/tcp
sudo firewall-cmd --permanent --add-port=5000/tcp
sudo firewall-cmd --reload
```

```powershell
# Windows
New-NetFirewallRule -DisplayName "BetterDesk" -Direction Inbound `
  -Protocol TCP -LocalPort 21114-21119,21121,5000 -Action Allow
New-NetFirewallRule -DisplayName "BetterDesk UDP" -Direction Inbound `
  -Protocol UDP -LocalPort 21116 -Action Allow
```

---

## Systemd Service Configuration

### Go Server (`/etc/systemd/system/betterdesk-server.service`)

```ini
[Unit]
Description=BetterDesk Server
After=network.target postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/rustdesk
ExecStart=/opt/betterdesk/betterdesk-server -port 21116 -relay-port 21117 -key id_ed25519
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Node.js Console (`/etc/systemd/system/betterdesk-console.service`)

```ini
[Unit]
Description=BetterDesk Console
After=network.target betterdesk-server.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/BetterDeskConsole
ExecStart=/usr/bin/node server.js
EnvironmentFile=/opt/BetterDeskConsole/.env
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

## Device Status Configuration

Fine-tune device status detection with these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PEER_TIMEOUT_SECS` | `15` | Seconds until device is marked offline |
| `HEARTBEAT_INTERVAL_SECS` | `3` | Status check interval |
| `HEARTBEAT_WARNING_THRESHOLD` | `2` | Missed heartbeats → DEGRADED |
| `HEARTBEAT_CRITICAL_THRESHOLD` | `4` | Missed heartbeats → CRITICAL |

### Status Levels

| Status | Description |
|--------|-------------|
| **Online** | All heartbeats received |
| **Degraded** | 2-3 missed heartbeats |
| **Critical** | 4+ missed heartbeats |
| **Offline** | Timeout exceeded |

---

## Reverse Proxy Configuration

### Nginx

```nginx
server {
    listen 443 ssl;
    server_name betterdesk.example.com;

    ssl_certificate /etc/letsencrypt/live/betterdesk.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/betterdesk.example.com/privkey.pem;

    # Web Console
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket (device status push)
    location /ws/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

> **Note:** Signal, relay, and client API ports (21114-21121) should NOT go through the reverse proxy. They use custom TCP/UDP protocols, not HTTP.

---

## See also

- [[TLS / SSL Certificates|TLS-SSL]] — certificates and dual-mode TLS
- [[Installation]] — default paths and services
- [[Docker Deployment|Docker]] — container env vars
- [[Panel Updates|Panel-Updates]] — `.env` merge on update
