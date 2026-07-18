# External Reverse Proxy Guide

Use this guide when **Caddy, Nginx, Nginx Proxy Manager, or Traefik** already terminate TLS on port **443** and proxy HTTP to BetterDesk on localhost.

> **Quick answer for Caddy users:** TLS belongs on Caddy. BetterDesk panel stays **HTTP on `127.0.0.1:5000`**. Set `HTTPS_ENABLED=false`, `TRUST_PROXY=Y`, and `HOST=127.0.0.1`. Do **not** run the installer's Let's Encrypt for the panel when Caddy owns certificates.

See also: [HTTPS Setup](HTTPS_SETUP.md) (native panel TLS vs proxy), [Configuration](../wiki/Configuration.md) (env reference).

---

## Choose your TLS model

| Model | When to use | Panel TLS | Signal/relay TLS | Cert management |
|-------|-------------|-----------|------------------|-----------------|
| **External reverse proxy** (this guide) | Caddy/Nginx/NPM on `:443` | Proxy (HTTPS → HTTP `:5000`) | Usually plain TCP/UDP; WSS via proxy paths | Your proxy (e.g. Caddy auto-LE) |
| **Native panel HTTPS** | No external proxy; direct access to server | BetterDesk `:5443` or `:443` | Optional Enterprise TLS on Go | Installer LE / custom cert |
| **Enterprise TLS** | Direct client access without HTTP proxy | BetterDesk HTTPS | Go `-tls-signal` / `-tls-relay` | Installer / custom cert |

**Do not combine** installer Let's Encrypt on the panel **and** external TLS on the same hostname — you get port conflicts, double certificates, and redirect loops.

---

## Architecture

```text
Internet
   │
   ▼
[Caddy/Nginx :443 TLS]
   ├── /              ──► http://127.0.0.1:5000   (Node.js panel)
   ├── /ws/id         ──► http://127.0.0.1:21118  (RustDesk signal WSS, optional)
   └── /ws/relay      ──► http://127.0.0.1:21119  (RustDesk relay WSS, optional)

Clients (RustDesk native) ──► TCP/UDP :21116, TCP :21117  (direct to host — not HTTP-proxied)
```

---

## BetterDesk configuration

### Installer (recommended)

```bash
sudo betterdesk.sh
```

Choose one of:

- **SSL Configuration (C)** → **External reverse proxy (Caddy/Nginx)**
- **Protocol Toggle (T)** → **External reverse proxy mode**

The installer applies `.env` + systemd settings and writes ready-to-copy snippets under:

```text
/opt/rustdesk/reverse-proxy/
  caddy.Caddyfile.snippet      # or nginx.betterdesk.conf.snippet
  betterdesk.env.snippet
  verify.sh
  firewall-notes.txt
```

### Manual `.env` (console)

```env
HOST=127.0.0.1
HTTPS_ENABLED=false
HTTP_REDIRECT_HTTPS=false
TRUST_PROXY=Y
PORT=5000

# When the public hostname differs from how you reach the server locally:
PANEL_PUBLIC_HOST=console.example.com
PANEL_PUBLIC_URL=https://console.example.com
PUBLIC_SERVER_ID=desk.example.com
PUBLIC_RELAY_SERVER=desk.example.com
PUBLIC_API_URL=https://api.example.com

# WebSocket origin allow-list (comma-separated); same-host browser upgrades are always allowed
WS_ALLOWED_ORIGINS=https://console.example.com
```

Restart after changes:

```bash
sudo systemctl restart betterdesk-console betterdesk-server
```

### Go server trust proxy

The Go REST API uses `X-Forwarded-For` for rate limits only when proxy trust is enabled. The Go **signal WebSocket** (`/ws/id` on port `21118`) also uses `X-Real-IP` / `X-Forwarded-For` for client session keys when trust is enabled — required for RustDesk WebSocket Mode behind Nginx/Caddy ([#276](https://github.com/UNITRONIX/BetterDesk/issues/276)).

Set **`TRUST_PROXY=Y`** in `betterdesk-server.service` (installer does this automatically), or add `-trust-proxy` to `ExecStart`.

> **Note:** `TRUST_PROXY=Y` in `.env` enables trust for **both** the Node.js panel and the Go server. Node also accepts `1` / `yes`; Go requires **`Y`**.

> **UDP/TCP signal** on port **21116** cannot use HTTP headers. `TRUST_PROXY` does not apply to native UDP/TCP rendezvous.

### Bind addresses

| Setting | Same-host proxy | Remote proxy (Caddy on another server) |
|---------|-----------------|----------------------------------------|
| `HOST` | `127.0.0.1` (default wizard) | `0.0.0.0` — wizard asks and sets this |
| Upstream in Caddy/Nginx | `127.0.0.1:5000` | BetterDesk LAN IP, e.g. `192.168.1.10:5000` |
| Firewall | Panel not WAN-exposed | Restrict `:5000` to proxy IP only |

`API_HOST` stays `0.0.0.0` by default so Client API (`:21121`) remains WAN-reachable unless you proxy it separately.

The installer wizard asks **“Is the reverse proxy on this server?”** — answer **No** when Caddy runs elsewhere; it sets `HOST=0.0.0.0` and uses your LAN IP in generated snippets.

---

## Caddy configuration

Caddy automatically obtains and renews Let's Encrypt certificates and sets `X-Forwarded-Proto`, `X-Forwarded-For`, and related headers on upstream requests.

### Panel only (browser console)

```caddy
console.example.com {
    reverse_proxy 127.0.0.1:5000

    encode gzip zstd
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }
}
```

### Panel + RustDesk WSS (same hostname)

When RustDesk clients use `allow-websocket=Y` and connect to `wss://desk.example.com/ws/id` and `/ws/relay`, route those paths **before** the catch-all panel proxy:

```caddy
desk.example.com {
    handle /ws/id {
        reverse_proxy 127.0.0.1:21118
    }
    handle /ws/relay {
        reverse_proxy 127.0.0.1:21119
    }
    reverse_proxy 127.0.0.1:5000

    encode gzip zstd
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }
}
```

Upstream to BetterDesk is always **`http://`** unless you enabled Enterprise TLS on Go ports (unusual behind an external proxy).

Reload Caddy after editing:

```bash
sudo systemctl reload caddy
# or: caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

---

## Nginx configuration

Full examples with WebSocket timeouts and RustDesk WSS paths are in [HTTPS_SETUP.md — Option 4](HTTPS_SETUP.md#option-4-reverse-proxy-with-nginx) and [RustDesk Client WSS Through Nginx](HTTPS_SETUP.md#rustdesk-client-wss-through-nginx).

Critical rules:

1. **`location = /ws/id` and `location = /ws/relay`** must appear **before** generic `location ~ ^/ws/` (panel routes).
2. Set `proxy_set_header X-Forwarded-Proto $scheme` and `X-Forwarded-For`.
3. Use `proxy_buffering off` and long `proxy_read_timeout` for `/ws/` paths (86400s for web remote).

---

## Split DNS / multiple hostnames

When the panel, ID server, relay, and Client API use different public names:

| Env variable | Example | Purpose |
|--------------|---------|---------|
| `PANEL_PUBLIC_HOST` | `console.example.com` | Dashboard client-config hostname |
| `PUBLIC_SERVER_ID` | `desk.example.com` | RustDesk ID server in client settings |
| `PUBLIC_RELAY_SERVER` | `desk.example.com` | Relay hostname (defaults to ID server) |
| `PUBLIC_API_URL` | `https://api.example.com` | Full Client API URL for deploy strings / QR |

You can also edit these in **Settings → Public client endpoints** (no console restart required for display values).

See [RustDesk Client Deployment](RUSTDESK_CLIENT_DEPLOYMENT.md).

---

## Firewall and ports

### Through the reverse proxy (HTTPS on `:443`)

- Panel HTTP, Web Remote, operator chat, MeshAgent `.ashx` paths → proxy to `:5000`
- RustDesk WSS (optional) → proxy `/ws/id` → `:21118`, `/ws/relay` → `:21119`

### Must reach the host directly (not HTTP reverse proxy)

| Port | Protocol | Service |
|------|----------|---------|
| 21116 | TCP + UDP | Signal (registration, hole punch) |
| 21117 | TCP | Relay data |
| 21121 | TCP | Client API (unless you add a separate API vhost) |

```bash
# Linux (ufw) — minimum for WAN RustDesk clients
sudo ufw allow 21116/tcp
sudo ufw allow 21116/udp
sudo ufw allow 21117/tcp
sudo ufw allow 21121/tcp
# Panel is localhost-only; proxy handles :443
sudo ufw allow 443/tcp
```

> **Cloudflare orange-cloud:** HTTP(S) and WebSocket can pass through; **UDP 21116 cannot**. Use DNS-only (grey cloud) for the ID server hostname or expose signal ports directly.

---

## Migration: already used installer Let's Encrypt

If you enabled Let's Encrypt in `betterdesk.sh` but Caddy should terminate TLS:

1. `sudo betterdesk.sh` → **SSL Configuration (C)** → **Disable SSL** (or **External reverse proxy**).
2. Confirm `.env`: `HTTPS_ENABLED=false`, `TRUST_PROXY=Y`, `HOST=127.0.0.1`.
3. Point Caddy at `http://127.0.0.1:5000`.
4. Open the panel at `https://your-domain/` (via Caddy), not `:5443`.
5. Clear browser HSTS/cache if you still get redirect loops (`chrome://net-internals/#hsts`).

BetterDesk LE files under `/opt/rustdesk/ssl/` are unused in external-proxy mode; Caddy keeps its own certificates.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Login redirect loop | `TRUST_PROXY` off or wrong | Set `TRUST_PROXY=Y`; ensure proxy sends `X-Forwarded-Proto: https` |
| Session cookie not set | Same as above | Caddy/Nginx must forward `X-Forwarded-Proto` |
| Web Remote stuck on "requesting connection" | WebSocket not upgraded | Enable WebSockets in proxy; `proxy_buffering off` on `/ws/` |
| WSS `401` / `403` on `/ws/id` | Routed to panel `:5000` instead of Go | Use exact `/ws/id` → `:21118` before catch-all |
| `AlertReceived(UnrecognisedName)` | TLS cert hostname mismatch | Fix cert on proxy for client hostname |
| Double TLS / protocol error | Proxy uses `https://` upstream | Upstream must be `http://127.0.0.1:…` unless Enterprise TLS on Go |
| Panel works but clients timeout | Firewall | Open 21116 UDP/TCP, 21117 TCP |

### Diagnostic commands

```bash
# Panel via proxy
curl -sI https://console.example.com/ | head -5

# Panel locally (should work after reverse-proxy mode)
curl -sI http://127.0.0.1:5000/ | head -5

# Console WebSocket upgrade
curl -i -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://console.example.com/ws/bd-signal

# RustDesk WSS (when configured)
curl -i -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://desk.example.com/ws/id
# Expected: HTTP/1.1 101 Switching Protocols
```

Run `$RUSTDESK_PATH/reverse-proxy/verify.sh` after using the installer reverse-proxy wizard.

---

## Related documentation

- [HTTPS Setup](HTTPS_SETUP.md) — native TLS, Nginx blocks, WSS troubleshooting table
- [Configuration](../wiki/Configuration.md) — full env reference
- [Docker + external proxy](../docker/DOCKER_SUPPORT.md#reverse-proxy-with-wss-rustdesk-clients)
- [OIDC SSO](../wiki/OIDC-SSO.md) — requires `TRUST_PROXY` for correct redirect URLs
