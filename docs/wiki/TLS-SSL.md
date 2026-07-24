# TLS / SSL Certificates

BetterDesk supports TLS encryption for all communication channels.

---

## Overview

| Channel | Flag | Port | Default |
|---------|------|------|---------|
| Signal (TCP) | `--tls-signal` | 21116 | Plain TCP |
| Relay (TCP) | `--tls-relay` | 21117 | Plain TCP |
| API (HTTP) | `--tls-api` | 21114 | HTTP |
| WS Signal | Auto with `--tls-signal` | 21118 | WS |
| WS Relay | Auto with `--tls-relay` | 21119 | WS |

> **Important:** By default, the API port (21114) stays HTTP even when `--tls-cert` and `--tls-key` are provided. This is intentional — the Node.js console connects to the Go API at `http://localhost:21114` and self-signed certs would break this local connection.

---

## Certificate Types

### Self-Signed Certificates

Best for testing or internal LAN deployments:

```bash
# Using the installer
sudo ./betterdesk.sh
# Choose option C → Self-signed

# Manual generation
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem \
  -days 3650 -nodes -subj "/CN=betterdesk"
```

**Self-signed behavior:**
- Signal and relay TLS enabled (`--tls-signal --tls-relay`)
- API stays HTTP (no `--tls-api`)
- WebSocket upgrades to WSS
- Clients must accept self-signed certificates

### Let's Encrypt (Recommended)

Free, auto-renewing certificates from Let's Encrypt:

```bash
# Using the installer
sudo ./betterdesk.sh
# Choose option C → Let's Encrypt

# Manual (certbot)
sudo certbot certonly --standalone -d betterdesk.example.com
```

**Let's Encrypt behavior:**
- All channels encrypted (signal, relay, API)
- Certificate auto-renewal via certbot timer
- No client warnings (trusted CA)

### Custom Certificates

Use your own CA-signed certificates:

```bash
# Using the installer
sudo ./betterdesk.sh
# Choose option C → Custom certificate
# Provide paths to cert.pem and key.pem
```

---

## Configuration

### CLI Flags

```bash
betterdesk-server \
  -tls-cert /path/to/cert.pem \
  -tls-key /path/to/key.pem \
  -tls-signal \
  -tls-relay
```

### Environment Variables

```bash
TLS_CERT=/path/to/cert.pem
TLS_KEY=/path/to/key.pem
TLS_SIGNAL=Y
TLS_RELAY=Y
TLS_API=Y         # Only for proper (non-self-signed) certs
```

### Systemd Service

The installer automatically adds TLS flags to the systemd service:

```ini
ExecStart=/opt/betterdesk/betterdesk-server \
  -port 21116 -relay-port 21117 \
  -tls-cert /opt/betterdesk/cert.pem \
  -tls-key /opt/betterdesk/key.pem \
  -tls-signal -tls-relay
```

---

## Dual-Mode Listener

BetterDesk uses a dual-mode listener that auto-detects TLS vs plain connections on the same port:

1. Server reads the first byte of each connection
2. If first byte is `0x16` (TLS ClientHello) → TLS handshake
3. Otherwise → treat as plain TCP
4. Both TLS and plain clients can connect on the same port simultaneously

This enables gradual TLS migration — old clients without TLS continue to work while new clients use TLS.

---

## SSL in the Installer

### Interactive SSL Configuration

```bash
sudo ./betterdesk.sh
# Choose option C — SSL Configuration
```

The installer offers:

1. **Let's Encrypt** — Automatic certificate via certbot
2. **Custom certificate** — Provide cert and key paths
3. **Self-signed** — Generate self-signed certificate
4. **Remove SSL** — Disable TLS and revert to plain TCP

### What the Installer Does

1. Installs/generates certificates
2. Updates systemd service with TLS flags
3. Restarts Go server
4. Updates `.env` with correct API URL scheme
5. Restarts Node.js console

### Windows

```powershell
.\betterdesk.ps1
# Choose option C — SSL Configuration
```

Same certificate options available. Certificates are stored in `C:\BetterDesk\`.

---

## Node.js Console + TLS

The Node.js web console (port 5000) does **not** directly use TLS from BetterDesk. For HTTPS on the web console, use a reverse proxy:

### Nginx Example

```nginx
server {
    listen 443 ssl;
    server_name betterdesk.example.com;

    ssl_certificate /etc/letsencrypt/live/betterdesk.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/betterdesk.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Set `TRUST_PROXY=true` in `.env` when using a reverse proxy.

---

## Troubleshooting

### Client shows "Failed to secure TCP"

1. Verify the public key in client config matches `id_ed25519.pub`
2. If using TLS, ensure the client supports TLS (RustDesk 1.2.0+)
3. Check certificate validity: `openssl x509 -in cert.pem -text -noout`

### API returns "client sent an HTTP request to an HTTPS server"

The API is running HTTPS but the Node.js console is connecting via HTTP. Fix:
- Remove `--tls-api` flag (recommended for self-signed certs)
- Or update `.env`: `BETTERDESK_API_URL=https://localhost:21114/api`

### WebSocket connection fails

1. WSS requires `--tls-signal` or `--tls-relay` (depends on the port)
2. Check `WS_ALLOWED_ORIGINS` env var allows the client origin
3. Verify certificate is valid and not expired

### Certificate renewal

For Let's Encrypt, certbot handles renewal automatically. After renewal:
```bash
sudo systemctl restart betterdesk-server
```

---

## See also

- [[Configuration]] — TLS flags and ports
- [[Security]] — encryption layers
- [[Client Setup|Client-Setup]] — HTTPS API server URLs
