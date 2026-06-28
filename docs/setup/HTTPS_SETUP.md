# HTTPS Setup Guide

BetterDesk Console supports native HTTPS with TLS certificates, as well as reverse proxy configurations with Caddy or Nginx.

## Quick Start

### Option 1: Native HTTPS (Self-Signed Certificate)

Generate a self-signed certificate for testing:

```bash
# Linux
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /opt/rustdesk/ssl/privkey.pem \
  -out /opt/rustdesk/ssl/fullchain.pem \
  -subj "/CN=betterdesk.local"
```

```powershell
# Windows (PowerShell)
$cert = New-SelfSignedCertificate -DnsName "betterdesk.local" -CertStoreLocation "cert:\LocalMachine\My" -NotAfter (Get-Date).AddYears(1)
Export-PfxCertificate -Cert $cert -FilePath C:\RustDesk\ssl\cert.pfx -Password (ConvertTo-SecureString -String "password" -Force -AsPlainText)
# Convert to PEM with OpenSSL or use .pfx directly
```

Then edit your `.env` file:

```env
HTTPS_ENABLED=true
HTTPS_PORT=5443
SSL_CERT_PATH=/opt/rustdesk/ssl/fullchain.pem
SSL_KEY_PATH=/opt/rustdesk/ssl/privkey.pem
HTTP_REDIRECT_HTTPS=true
```

Restart the console service and access it at `https://your-server:5443`.

### Option 2: Let's Encrypt (Production)

Using [Certbot](https://certbot.eff.org/):

```bash
# Install certbot
sudo apt install certbot

# Get certificate (standalone mode - stop BetterDesk console first)
sudo systemctl stop betterdesk-console
sudo certbot certonly --standalone -d console.yourdomain.com
sudo systemctl start betterdesk-console
```

Update `.env`:

```env
HTTPS_ENABLED=true
HTTPS_PORT=443
SSL_CERT_PATH=/etc/letsencrypt/live/console.yourdomain.com/fullchain.pem
SSL_KEY_PATH=/etc/letsencrypt/live/console.yourdomain.com/privkey.pem
SSL_CA_PATH=/etc/letsencrypt/live/console.yourdomain.com/chain.pem
HTTP_REDIRECT_HTTPS=true
```

Set up auto-renewal:

```bash
# Add to crontab
0 0 1 * * certbot renew --pre-hook "systemctl stop betterdesk-console" --post-hook "systemctl start betterdesk-console"
```

### Option 3: Reverse Proxy with Caddy (Recommended for Production)

[Caddy](https://caddyserver.com/) automatically provisions and renews HTTPS certificates.

```bash
# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

Create `/etc/caddy/Caddyfile`:

```caddy
console.yourdomain.com {
    reverse_proxy localhost:5000

    # Optional: compress responses
    encode gzip zstd

    # Security headers (Caddy adds HSTS by default)
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }
}
```

```bash
sudo systemctl enable caddy
sudo systemctl start caddy
```

With Caddy, leave `HTTPS_ENABLED=false` in `.env` since Caddy handles TLS termination.

### Option 4: Reverse Proxy with Nginx

Install Nginx and Certbot:

```bash
sudo apt install nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/betterdesk`:

```nginx
# Upstream map for WebSocket connection upgrade
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# BetterDesk Console
server {
    listen 80;
    server_name console.yourdomain.com;

    # Increase client body size for file uploads
    client_max_body_size 100M;

    # ─────────────────────────────────────────────────────────────────────────
    # Console WebSocket endpoints (Web Remote Client, Chat, Relay)
    # These require special handling for long-lived connections.
    # RustDesk client WSS uses exact /ws/id and /ws/relay locations below.
    # ─────────────────────────────────────────────────────────────────────────
    location ~ ^/ws/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;

        # WebSocket upgrade headers
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Preserve client info
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Disable buffering for real-time streaming (JPEG frames)
        proxy_buffering off;
        proxy_cache off;

        # Long timeouts for persistent WebSocket connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;

        # Keepalive
        proxy_socket_keepalive on;
    }

    # ─────────────────────────────────────────────────────────────────────────
    # Standard HTTP requests (dashboard, API, static files)
    # ─────────────────────────────────────────────────────────────────────────
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Fallback WebSocket support for non-/ws/ paths (legacy)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/betterdesk /etc/nginx/sites-enabled/
sudo nginx -t  # Validate configuration
sudo certbot --nginx -d console.yourdomain.com
sudo systemctl restart nginx
```

With Nginx reverse proxy, leave `HTTPS_ENABLED=false` in `.env`.

**Important for Web Remote Client:**
- The `proxy_buffering off` directive is critical for real-time JPEG streaming
- Long timeouts (86400s) prevent WebSocket disconnections during idle periods
- The `map` directive ensures proper WebSocket upgrade handling

### RustDesk Client WSS Through Nginx

RustDesk's native client and web client use the Go server WebSocket ports, not
the Node.js console WebSocket routes:

| Public path | Upstream | Purpose |
|-------------|----------|---------|
| `/ws/id` | `21118` | Rendezvous / ID server over WebSocket |
| `/ws/relay` | `21119` | Relay server over WebSocket |

If Nginx runs on the Docker host, proxy to the published localhost ports. If
Nginx runs in the same Docker network, replace `127.0.0.1` with the BetterDesk
server container name, for example `betterdesk-server` or `betterdesk`.

```nginx
# RustDesk / BetterDesk signal WebSocket (hbbs-compatible)
location = /ws/id {
    proxy_pass http://127.0.0.1:21118;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}

# RustDesk / BetterDesk relay WebSocket (hbbr-compatible)
location = /ws/relay {
    proxy_pass http://127.0.0.1:21119;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
```

Notes:

- Build or configure RustDesk clients with `allow-websocket=Y` when you want the
    native client to use WSS instead of TCP/UDP signaling.
- Do not point `/ws/id` or `/ws/relay` at the console port (`5000`). These paths
    must reach the Go server ports `21118` and `21119`.
- Keep these as exact `location = ...` entries when your server block also has a
    generic console `location ~ ^/ws/` rule.
- Keep `proxy_read_timeout` above 60 seconds. RustDesk expects long-lived signal
    WebSockets and uses empty binary frames as keepalive traffic.
- When using only WSS on port 443, remove hard-coded relay values such as
    `host:21117` from the client or console relay settings; otherwise the client
    may still try the raw TCP relay port.

### Nginx Proxy Manager (NPM) with Docker

When BetterDesk runs in Docker (bridge mode) and NPM runs on the **host** (host
network mode), TLS terminates at NPM on port 443. NPM must forward RustDesk WSS
paths to the **published host ports**, not the console container port.

| NPM setting | Value |
|-------------|-------|
| Domain | Your public hostname (must match RustDesk client ID server) |
| Forward Hostname / Port | `HOST_IP:5000` (console panel) |
| Websockets Support | **ON** |
| Custom Location `/ws/id` | `http://HOST_IP:21118` — Websockets **ON** |
| Custom Location `/ws/relay` | `http://HOST_IP:21119` — Websockets **ON** |

Replace `HOST_IP` with `127.0.0.1` or the Docker host LAN address. Do **not**
use the Docker container name (for example `betterdesk-server:21118`) when NPM
runs outside the Docker network namespace.

Backend scheme must be **`http://`** unless you enabled Enterprise TLS on the Go
server (`-tls-signal` / `-tls-relay`). With default Docker images, the Go server
listens for plain WebSocket on `21118` / `21119`; NPM handles HTTPS/WSS on 443.

Keep `HTTPS_ENABLED=false` in the console `.env` when NPM terminates TLS.

See also [Docker + external proxy](../docker/DOCKER_SUPPORT.md#reverse-proxy-with-wss-rustdesk-clients).

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTPS_ENABLED` | `false` | Enable native HTTPS server |
| `HTTPS_PORT` | `5443` | HTTPS listening port |
| `SSL_CERT_PATH` | *(empty)* | Path to SSL certificate (PEM format) |
| `SSL_KEY_PATH` | *(empty)* | Path to SSL private key (PEM format) |
| `SSL_CA_PATH` | *(empty)* | Path to CA bundle / chain (optional) |
| `HTTP_REDIRECT_HTTPS` | `true` | Redirect HTTP traffic to HTTPS when HTTPS is enabled |

## Security Notes

When HTTPS is enabled, BetterDesk Console automatically:

- Enables **HSTS** (Strict-Transport-Security) header with 1 year max-age
- Sets `Secure` flag on session cookies
- Enables `upgrade-insecure-requests` CSP directive
- Enables Cross-Origin-Opener-Policy `same-origin`
- Allows `wss://` in Content-Security-Policy for future WebSocket connections

When HTTPS is **not** enabled (default), these stricter policies are disabled to avoid breaking HTTP-only deployments on internal networks.

## Firewall Rules

If you enable native HTTPS, make sure to open the HTTPS port:

```bash
# Linux (ufw)
sudo ufw allow 5443/tcp

# Linux (firewalld)
sudo firewall-cmd --permanent --add-port=5443/tcp
sudo firewall-cmd --reload
```

```powershell
# Windows
New-NetFirewallRule -DisplayName "BetterDesk HTTPS" -Direction Inbound -Protocol TCP -LocalPort 5443 -Action Allow
```

## Troubleshooting

### "HTTPS enabled but certificates not found/invalid"

The server will log this warning and fall back to HTTP mode. Check:
1. Certificate file paths in `.env` are correct
2. Files are readable by the BetterDesk process (check permissions)
3. Certificate format is PEM (not DER or PFX)

### Certificate Permission Errors

Let's Encrypt live directories are root-only. **BetterDesk copies** renewed material into `$RUSTDESK_PATH/ssl/betterdesk.{crt,key}` with `root:betterdesk` permissions when you use Protocol Toggle or SSL config in `betterdesk.sh`.

If an older build left **symlinks** into `/etc/letsencrypt/` and HTTPS fails (panel on `:5000` only, journal shows *Falling back to HTTP*), repair manually:

```bash
sudo betterdesk.sh   # Repair / Updates — ensure_betterdesk_console_user redeploys LE symlinks
# Or one-time copy:
sudo cp -L /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem /opt/rustdesk/ssl/betterdesk.crt
sudo cp -L /etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem /opt/rustdesk/ssl/betterdesk.key
sudo chown root:betterdesk /opt/rustdesk/ssl/betterdesk.{crt,key}
sudo chmod 640 /opt/rustdesk/ssl/betterdesk.{crt,key}
sudo systemctl restart betterdesk-console betterdesk-server
```

Legacy workaround (not recommended — prefer copy above):

```bash
sudo chmod 644 /etc/letsencrypt/live/console.yourdomain.com/fullchain.pem
sudo chmod 640 /etc/letsencrypt/live/console.yourdomain.com/privkey.pem
sudo chgrp root /etc/letsencrypt/live/console.yourdomain.com/privkey.pem
```

### Mixed Content Warnings

If you access the console via HTTPS but see mixed content warnings, ensure `HTTPS_ENABLED=true` is set so the security middleware enables `upgrade-insecure-requests`.

### Behind a Reverse Proxy

When using a reverse proxy (Caddy/Nginx), keep `HTTPS_ENABLED=false` and let the proxy handle TLS. The proxy should set `X-Forwarded-Proto: https` so the application knows the original protocol. Express trusts proxy headers when configured—this is handled automatically.

### RustDesk WSS Symptom Guide

| Client log / symptom | Likely cause | Fix |
|----------------------|--------------|-----|
| `AlertReceived(UnrecognisedName)` on `wss://domain/ws/id` | TLS certificate on `:443` does not match the domain (SNI mismatch) | Issue or renew NPM/nginx cert for that hostname; verify NAT forwards 443 to the proxy |
| `An unexpected message has been received...` (native-tls) | Protocol mismatch at TLS layer (plain HTTP backend, wrong port, or double TLS) | Ensure NPM proxies to `http://HOST:21118`, not `https://`, unless Enterprise TLS is enabled on Go |
| `Rendezvous connection is timeout` after `Client handshake done` | Keepalive / proxy timeout after successful WSS upgrade | Update BetterDesk (fix in [#144](https://github.com/UNITRONIX/BetterDesk/issues/144)); set `proxy_read_timeout` ≥ 120s on `/ws/id` |
| `Rendezvous connection is reset by the peer` ~30s after handshake | Peer marked offline; keepalive not reaching server | Same as above; confirm `/ws/id` reaches port `21118`, not console `:5000` |
| `HTTP/1.1 401` or `403` on WebSocket upgrade | Console session / origin check (panel paths, not RustDesk `/ws/id`) | Route `/ws/id` and `/ws/relay` to Go ports `21118` / `21119` |

**Diagnostic commands** (run from the reverse-proxy host):

```bash
# 1. Certificate covers the client hostname?
openssl s_client -connect YOUR_DOMAIN:443 -servername YOUR_DOMAIN </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -ext subjectAltName

# 2. Go signal WebSocket reachable locally?
curl -i -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://127.0.0.1:21118/ws/id

# 3. Proxy forwards WSS correctly?
curl -i -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://YOUR_DOMAIN/ws/id
```

### Web Remote Client Not Working Through Nginx

If the web remote desktop client connects but shows "requesting connection" indefinitely:

1. **Verify WebSocket upgrade is working:**
   ```bash
   # Test WebSocket endpoint
   curl -i -N \
     -H "Connection: Upgrade" \
     -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" \
     -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
     https://console.yourdomain.com/ws/bd-signal
   # Should return "HTTP/1.1 101 Switching Protocols"
   ```

2. **Check nginx `proxy_buffering` is disabled** for `/ws/` paths (see config above)

3. **Verify timeouts are long enough** — `proxy_read_timeout 86400s`

4. **Check nginx error logs:**
   ```bash
   sudo tail -f /var/log/nginx/error.log
   ```

5. **Ensure the desktop agent (BetterDesk Client) can reach the server.** The agent must connect to `/ws/remote-agent/<device_id>` before the browser viewer can stream.

### BetterDesk Server (Go) WebSocket Ports

The BetterDesk Go server also exposes WebSocket endpoints for RustDesk protocol:

| Port | Protocol | Purpose |
|------|----------|---------|
| 21118 | WS/WSS | Signal WebSocket (RustDesk client signaling) |
| 21119 | WS/WSS | Relay WebSocket (RustDesk client data relay) |

These ports are used by the **native RustDesk desktop client** (not the web console). If you need to proxy them through nginx:

```nginx
# Optional: Proxy RustDesk native client WebSocket (if needed)
server {
    listen 21118;
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:21118;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400s;
    }
}

server {
    listen 21119;
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:21119;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400s;
    }
}
```

> **Note:** For most deployments, you do NOT need to proxy ports 21118/21119 — let clients connect directly to the Go server.

---

## Installer SSL Configuration (Option C)

The BetterDesk ALL-IN-ONE installers (`betterdesk.sh`, `betterdesk.ps1`, `betterdesk-docker.sh`) include a built-in SSL configuration menu accessible via **Option C** in the main menu.

### SSL Menu Options

| Option | Description |
|--------|-------------|
| **1. Let's Encrypt** | Automated certificate provisioning (requires port 80 and valid DNS) |
| **2. Custom Certificate** | Use your own certificate from a CA or existing infrastructure |
| **3. Self-Signed Certificate** | Generate a self-signed cert (development/testing/LAN only) |
| **4. Disable SSL** | Remove TLS configuration, run in HTTP-only mode |
| **5. Enterprise TLS** | Full HTTPS on ALL ports including Go server API (21114) |

### During Fresh Install

After a successful fresh installation, the installer prompts:

```
🔒 Enterprise TLS enables full HTTPS on ALL ports (panel, signal, relay, API)
   Recommended for production. Requires RustDesk client >= 1.3.x

Would you like to configure HTTPS Enterprise now? (Option 5 in SSL menu) [y/N]
```

Selecting "y" opens the SSL configuration menu where you can choose **Option 5** for full Enterprise TLS.

---

## Enterprise TLS (Full HTTPS on All Ports)

Enterprise TLS enables HTTPS/TLS on **all BetterDesk ports**, not just the web console:

| Port | Component | Without Enterprise TLS | With Enterprise TLS |
|------|-----------|------------------------|---------------------|
| 5000/5443 | Web Console | HTTP/HTTPS | HTTPS |
| 21114 | Go Server API | HTTP | **HTTPS** |
| 21116 | Signal Server (TCP) | Plain TCP | **TLS** |
| 21117 | Relay Server (TCP) | Plain TCP | **TLS** |
| 21118 | Signal WebSocket | WS | **WSS** |
| 21119 | Relay WebSocket | WS | **WSS** |

### Requirements

- **RustDesk client version 1.3.x or newer** — older clients do not support TLS on signal/relay ports
- Valid TLS certificate (Let's Encrypt, custom CA, or self-signed for testing)
- Certificate SAN (Subject Alternative Name) should include:
  - Domain name (e.g., `betterdesk.example.com`)
  - Public IP address
  - LAN IP address (if used internally)
  - `localhost` and `127.0.0.1` (for local connections)

### Go Server TLS Flags

The Go server supports the following TLS-related flags:

```bash
# Certificate paths
-tls-cert /path/to/fullchain.pem
-tls-key /path/to/privkey.pem

# Enable TLS per component
-tls-signal    # TLS on signal port (21116)
-tls-relay     # TLS on relay port (21117)
-tls-api       # HTTPS on API port (21114)

# Force HTTPS redirect
-force-https   # Implies -tls-api
```

### Systemd Service Configuration (Linux)

When Enterprise TLS is enabled via the installer, the systemd service is configured with:

```ini
[Service]
ExecStart=/opt/rustdesk/betterdesk-server \
    -key-dir /opt/rustdesk \
    -db-path /opt/rustdesk/db_v2.sqlite3 \
    -relay-servers YOUR_PUBLIC_IP:21117 \
    -tls-cert /opt/rustdesk/ssl/betterdesk.crt \
    -tls-key /opt/rustdesk/ssl/betterdesk.key \
    -tls-signal \
    -tls-relay

Environment="TLS_SIGNAL=Y"
Environment="TLS_RELAY=Y"
```

### Node.js Console Configuration

The `.env` file is updated with:

```env
HTTPS_ENABLED=true
HTTPS_PORT=5443
SSL_CERT_PATH=/opt/rustdesk/ssl/betterdesk.crt
SSL_KEY_PATH=/opt/rustdesk/ssl/betterdesk.key
HTTP_REDIRECT_HTTPS=true
ALLOW_SELF_SIGNED_CERTS=true  # For self-signed certs (dev/LAN)
ENTERPRISE_TLS=true
```

### Important Notes

1. **Self-signed certificates and API**: When using self-signed certificates, the Go server API (21114) is kept on HTTP to avoid breaking internal communication between Node.js console and Go server. Signal/relay ports still use TLS.

2. **Browser certificate warnings**: Self-signed certificates will cause browser warnings. Users must manually accept the certificate or add it to their trusted store.

3. **RustDesk client configuration**: Clients must be configured with the same server address. If using a domain with Let's Encrypt, ensure the domain resolves correctly.

4. **Mixed TLS/plain connections**: The Go server supports a "dual-mode listener" that auto-detects TLS vs plain connections on the same port (first-byte 0x16 detection). This allows gradual migration without breaking older clients.

### Troubleshooting Enterprise TLS

#### Clients show "connection timeout" after enabling TLS

- Verify RustDesk client is version 1.3.x or newer
- Check that the Go server started successfully: `journalctl -u betterdesk-server -n 50`
- Ensure certificate SAN includes the IP/domain the client is connecting to

#### "Failed to secure tcp: deadline has elapsed"

- The client is trying TLS but the server isn't configured for it (or vice versa)
- Check `-tls-signal` flag is present in Go server ExecStart

#### Web console shows "0 devices" after enabling Enterprise TLS

- Internal Node.js → Go API communication may be broken if API is now HTTPS with self-signed
- For self-signed certs, check `ALLOW_SELF_SIGNED_CERTS=true` in `.env`
- Or keep API on HTTP (don't use `-tls-api`) — only signal/relay need TLS for security
