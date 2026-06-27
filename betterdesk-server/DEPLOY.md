# BetterDesk Go Server — Deployment Guide

## Overview

BetterDesk Go Server is a **single binary** that replaces the Rust `hbbs` (signal) + `hbbr` (relay) servers. It is fully compatible with original RustDesk clients and provides additional features:

- **Combined service**: Signal + Relay + HTTP API + Admin TCP in one process
- **Enhanced device tracking**: Online/Offline/Degraded/Critical status with configurable timeouts
- **Security**: JWT auth, TOTP 2FA, RBAC, API keys, rate limiting, connection limiting
- **Observability**: Prometheus metrics, structured JSON logging, audit trail
- **WebSocket support**: Signal and Relay over WebSocket for restricted networks

## Prerequisites

- Linux x86_64 
- Root/sudo access
- Ports 21114-21119 + 21000 available
- Existing RustDesk/BetterDesk installation (optional, for migration)

## Quick Deployment

### 1. Upload files to server

```bash
# From your local machine, upload the deployment files
scp betterdesk-server-linux-amd64 user@server:/tmp/
scp tools/migrate/migrate-linux-amd64 user@server:/tmp/
scp deploy.sh user@server:/tmp/
```

### 2. Run the deployment script

```bash
ssh user@server

# Make executable
chmod +x /tmp/deploy.sh

# Interactive deployment (recommended for first time)
sudo /tmp/deploy.sh

# OR automatic deployment with defaults
sudo /tmp/deploy.sh --auto
```

### 3. Verify

```bash
# Check service status
systemctl status betterdesk

# Check API health
curl http://localhost:21114/api/health

# Check logs
journalctl -u betterdesk -f

# Get initial admin credentials (printed at first start)
journalctl -u betterdesk | grep "INITIAL ADMIN"
```

## Manual Deployment

### Step 1: Backup existing database

```bash
# Create backup directory
mkdir -p /opt/betterdesk/backups

# Backup existing database (adjust path to your installation)
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
cp /opt/rustdesk/db_v2.sqlite3 /opt/betterdesk/backups/db_v2.sqlite3.${TIMESTAMP}
cp /opt/rustdesk/db_v2.sqlite3-wal /opt/betterdesk/backups/db_v2.sqlite3-wal.${TIMESTAMP} 2>/dev/null
cp /opt/rustdesk/db_v2.sqlite3-shm /opt/betterdesk/backups/db_v2.sqlite3-shm.${TIMESTAMP} 2>/dev/null

# Backup key files
cp /opt/rustdesk/id_ed25519 /opt/betterdesk/backups/id_ed25519.${TIMESTAMP}
cp /opt/rustdesk/id_ed25519.pub /opt/betterdesk/backups/id_ed25519.pub.${TIMESTAMP}
```

### Step 2: Migrate database

```bash
# Run migration tool
./migrate-linux-amd64 -src /opt/rustdesk/db_v2.sqlite3 -dst /opt/betterdesk/data/db_v2.sqlite3
```

### Step 3: Stop old services

```bash
sudo systemctl stop rustdesksignal rustdeskrelay
sudo systemctl disable rustdesksignal rustdeskrelay
```

### Step 4: Install binary

```bash
sudo mkdir -p /opt/betterdesk/data /var/log/betterdesk
sudo cp betterdesk-server-linux-amd64 /opt/betterdesk/betterdesk-server
sudo chmod +x /opt/betterdesk/betterdesk-server

# Copy existing key file (important for client compatibility!)
sudo cp /opt/rustdesk/id_ed25519 /opt/betterdesk/data/
sudo cp /opt/rustdesk/id_ed25519.pub /opt/betterdesk/data/
```

### Step 5: Create systemd service

```bash
sudo cat > /etc/systemd/system/betterdesk.service << 'EOF'
[Unit]
Description=BetterDesk Server (Signal + Relay + API)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/betterdesk/data
ExecStart=/opt/betterdesk/betterdesk-server \
    -mode all \
    -db /opt/betterdesk/data/db_v2.sqlite3 \
    -key-file /opt/betterdesk/data/id_ed25519 \
    -port 21116 \
    -relay-port 21117 \
    -api-port 21114 \
    -admin-port 21000 \
    -log-format json \
    -audit-log /var/log/betterdesk/audit.jsonl
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable betterdesk
sudo systemctl start betterdesk
```

### Step 6: Open firewall ports

```bash
# UFW
sudo ufw allow 21114:21119/tcp
sudo ufw allow 21116/udp

# OR firewalld
sudo firewall-cmd --permanent --add-port=21114-21119/tcp
sudo firewall-cmd --permanent --add-port=21116/udp
sudo firewall-cmd --reload
```

## Port Reference

| Port  | Protocol | Service          | Description                    |
|-------|----------|------------------|--------------------------------|
| 21114 | TCP      | HTTP API         | REST API, health checks        |
| 21115 | TCP      | NAT Test         | NAT type detection             |
| 21116 | UDP+TCP  | Signal Server    | Client registration, ID lookup |
| 21117 | TCP      | Relay Server     | Connection relay               |
| 21118 | TCP      | WebSocket Signal | Signal over WS (web clients)   |
| 21119 | TCP      | WebSocket Relay  | Relay over WS (restricted networks) |
| 21000 | TCP      | Admin TCP        | Admin command interface (LAN only) |

## Configuration

### Command-line flags

```
-mode string        Server mode: all, signal, relay (default "all")
-port int           Signal server port (default 21116)
-relay-port int     Relay server port (default 21117)
-api-port int       HTTP API port (default 21114)
-admin-port int     Admin TCP port (default 21000), 0 to disable
-db string          SQLite database path (default "db_v2.sqlite3")
-key-file string    Ed25519 key file path (default "id_ed25519")
-relay string       External relay address (host:port)
-log-format string  Log format: text, json (default "text")
-log-level string   Log level: debug, info, warn, error (default "info")
-audit-log string   Audit log file path (default "" = disabled)
```

### Environment variables

| Variable               | Default    | Description                         |
|------------------------|------------|-------------------------------------|
| `JWT_SECRET`           | auto       | JWT signing secret                  |
| `ADMIN_PASSWORD`       | auto       | Initial admin password              |
| `FORCE_HTTPS`          | N          | Require HTTPS for API               |
| `RELAY_MAX_CONNS_PER_IP` | 20      | Max relay connections per IP        |
| `SIGNAL_RATE_LIMIT_PER_IP` | 20   | Max signal registrations per proxy/client bucket per minute (`0` disables) |
| `TLS_CERT`             | -          | TLS certificate path                |
| `TLS_KEY`              | -          | TLS private key path                |
| `PEER_TIMEOUT_SECS`    | 15         | Seconds before peer marked offline  |
| `TRUST_PROXY`          | N          | Trust X-Forwarded-For header        |
| `NTP_SERVERS`            | public pools | Comma-separated NTP hostnames/IPs for billing clock checks |
| `BILLING_MAX_CLOCK_SKEW_MS` | 2000    | Max allowed clock offset vs NTP (ms) |
| `BILLING_REQUIRE_SYNCED_CLOCK` | Y (Linux default) | Block billable sessions when clock unsynced |
| `BILLING_TRUST_OS_NTP`   | Y on Linux, N elsewhere | Trust `timedatectl` when direct NTP queries fail |

NTP/billing variables are stored in the web console `.env` on native installs. Linux `betterdesk-server.service` loads that file via `EnvironmentFile`. After changing NTP settings, restart **betterdesk-server** (not only the console). The panel path: **Commercialization → Settings → Server time (NTP)**.

For NGINX `stream` or other UDP/TCP reverse proxy deployments, remember that signal traffic on `21116` is not HTTP and cannot carry `X-Forwarded-For`. `TRUST_PROXY` only applies to HTTP/API handlers. If many legitimate devices share the same proxy address, raise `SIGNAL_RATE_LIMIT_PER_IP` or set it to `0` only on trusted private networks.

## Migration from Rust (hbbs-patch-v2)

### What gets migrated

The migration tool converts data from the Rust `peer` table to the Go `peers` table:

| Rust Column | Go Column    | Transformation                    |
|-------------|-------------|-----------------------------------|
| `guid`      | `uuid`      | BLOB → hex string                 |
| `id`        | `id` (PK)   | Used as primary key               |
| `info` JSON | `hostname`, `os`, `version` | JSON parsed into columns |
| `status`    | `status`    | 0→OFFLINE, 1→ONLINE              |
| `user`      | `user`      | BLOB → string                     |
| `is_banned` | `banned`    | 1→true, 0/NULL→false             |
| `is_deleted`| `soft_deleted` | 1→true, 0/NULL→false          |
| `last_online`| `last_online` | Preserved as-is                 |

### Key file compatibility

**IMPORTANT**: The Ed25519 key file (`id_ed25519`) from the Rust server is fully compatible. Copy it to the new installation to keep your existing clients connected without reconfiguration.

### Backup-only mode

```bash
# Only create a backup without installing anything
./migrate-linux-amd64 -src /opt/rustdesk/db_v2.sqlite3 -backup-only
```

## Rollback

If something goes wrong, you can revert to the Rust server:

### Using the deploy script

```bash
sudo /path/to/deploy.sh --rollback
```

### Manual rollback

```bash
# Stop Go server
sudo systemctl stop betterdesk
sudo systemctl disable betterdesk

# Restore backup
cp /opt/betterdesk/backups/backup_YYYYMMDD_HHMMSS/db_v2.sqlite3 /opt/rustdesk/
cp /opt/betterdesk/backups/backup_YYYYMMDD_HHMMSS/id_ed25519 /opt/rustdesk/

# Re-enable old services
sudo systemctl enable rustdesksignal rustdeskrelay
sudo systemctl start rustdesksignal rustdeskrelay
```

## Troubleshooting

### Service won't start

```bash
# Check logs
journalctl -u betterdesk -n 100 --no-pager

# Common issues:
# - Port already in use → check if old hbbs/hbbr is still running
# - Permission denied → ensure /opt/betterdesk/data is writable
# - Key file not found → check -key-file path
```

### Clients can't connect

1. **Check ports are open**: `ss -tlnp | grep 2111`
2. **Check firewall**: `ufw status` or `firewall-cmd --list-all`
3. **Check key file**: Clients store the server public key. If the key changed, clients need reconfiguration
4. **Check DNS/IP**: Ensure clients point to the correct server address

### Devices show offline

1. **Check API**: `curl http://localhost:21114/api/peers`
2. **Check signal logs**: `journalctl -u betterdesk | grep RegisterPeer`
3. **Increase timeout**: Set `PEER_TIMEOUT_SECS=30` in service environment

### Performance tuning

```bash
# Increase file descriptor limit in service
LimitNOFILE=131072

# Increase relay bandwidth
# (set via API or admin TCP)
```

## API Quick Reference

```bash
# Health check
curl http://localhost:21114/api/health

# List all peers
curl http://localhost:21114/api/peers

# Server statistics
curl http://localhost:21114/api/server/stats

# Peer statistics
curl http://localhost:21114/api/peers/stats

# Login (get JWT token)
curl -X POST http://localhost:21114/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YOUR_PASSWORD"}'

# Use JWT token
curl http://localhost:21114/api/peers \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Architecture

```
                          ┌─────────────────────────┐
                          │   betterdesk-server      │
                          │   (single binary)        │
  ┌───────────────────────┼─────────────────────────┤
  │                       │                         │
  │  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
  │  │  Signal   │  │  Relay   │  │ HTTP API │     │
  │  │  Server   │  │  Server  │  │  Server  │     │
  │  │          │  │          │  │          │     │
  │  │ UDP:21116│  │ TCP:21117│  │ TCP:21114│     │
  │  │ TCP:21116│  │ WS:21119 │  │          │     │
  │  │ WS:21118 │  │          │  │          │     │
  │  │ NAT:21115│  │          │  │          │     │
  │  └──────────┘  └──────────┘  └──────────┘     │
  │       │              │              │           │
  │  ┌────┴──────────────┴──────────────┴──────┐   │
  │  │              SQLite Database             │   │
  │  │         /opt/betterdesk/data/            │   │
  │  │         db_v2.sqlite3                    │   │
  │  └─────────────────────────────────────────┘   │
  │                                                 │
  │  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
  │  │  Auth    │  │  Audit   │  │ Metrics  │     │
  │  │  JWT/2FA │  │  Events  │  │Prometheus│     │
  │  └──────────┘  └──────────┘  └──────────┘     │
  └─────────────────────────────────────────────────┘
```
