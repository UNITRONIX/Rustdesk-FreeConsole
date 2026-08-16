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
   ├── /                 ──► http://127.0.0.1:5000   (Node.js panel)
   ├── /ws/rendezvous    ──► http://127.0.0.1:5000   (Web Remote → hbbs TCP :21116)
   ├── /ws/relay         ──► http://127.0.0.1:5000   (Web Remote → hbbr TCP :21117)
   ├── /ws/id            ──► http://127.0.0.1:21118  (native RustDesk signal WSS, optional)
   └── /ws/relay (native)──► http://127.0.0.1:21119  (native RustDesk relay WSS — same path; see collision note)

Clients (RustDesk native) ──► TCP/UDP :21116, TCP :21117  (direct to host — not HTTP-proxied)
```

> **Web Remote vs native WSS:** Never route `/ws/rendezvous` to Go `:21118`. The browser client sends **TCP-framed** protobufs and the panel bridges them to hbbs TCP. Go WSS expects **raw** protobuf — a wrong upstream closes the socket immediately with code **1000** (see [#329](https://github.com/UNITRONIX/BetterDesk/issues/329)). `/ws/relay` is owned by **both** Web Remote (panel `:5000`) and optional native WebSocket Mode (Go `:21119`); on one hostname prefer the panel catch-all for Web Remote, or put native WSS on a separate host/port.
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

Set **`TRUST_PROXY=Y`** and **`TRUSTED_PROXIES`** to the reverse proxy’s address(es) as CIDR or bare IP.

Same-host Nginx/Caddy (typical):

```bash
TRUST_PROXY=Y
TRUSTED_PROXIES=127.0.0.1/32,::1/128
```

Remote proxy on the LAN:

```bash
TRUST_PROXY=Y
TRUSTED_PROXIES=192.168.1.5/32
```

Or add `-trust-proxy` and `-trusted-proxies=127.0.0.1/32` to `ExecStart`. The installer sets `-trust-proxy` in reverse-proxy mode; after this release, also set `TRUSTED_PROXIES` in `.env` (panel update merges the key from `.env.example`).

> **Security:** `TRUST_PROXY=Y` alone is not enough. If `TRUSTED_PROXIES` is empty, the Go server **ignores** forwarded headers and logs a configuration warning. Bind signal/API so only the proxy can connect, or attackers could otherwise spoof client IPs.

> **Note:** `TRUST_PROXY=Y` in `.env` enables trust for **both** the Node.js panel and the Go server. Node also accepts `1` / `yes`; Go requires **`Y`**. `TRUSTED_PROXIES` is read by the **Go server** (session keys / API client IP).

> **UDP/TCP signal** on port **21116** cannot use HTTP headers. `TRUST_PROXY` / `TRUSTED_PROXIES` do not apply to native UDP/TCP rendezvous.

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

### Panel + Web Remote (same hostname)

Web Remote needs `/ws/rendezvous` and `/ws/relay` on the **panel**. Do not add `/ws/rendezvous` to any Go `:21118` matcher.

```caddy
desk.example.com {
    # Optional: native RustDesk WebSocket Mode (signal only)
    handle /ws/id {
        reverse_proxy http://127.0.0.1:21118
    }

    # Catch-all: panel UI + Web Remote (/ws/rendezvous, /ws/relay)
    reverse_proxy http://127.0.0.1:5000

    encode gzip zstd
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }
}
```

### Panel + native RustDesk WSS (same hostname, no Web Remote relay)

When desktop clients use `allow-websocket=Y` and you do **not** need browser Web Remote on this vhost, you may also route native relay WSS:

```caddy
desk.example.com {
    handle /ws/id {
        reverse_proxy http://127.0.0.1:21118
    }
    handle /ws/relay {
        reverse_proxy http://127.0.0.1:21119
    }
    reverse_proxy http://127.0.0.1:5000

    encode gzip zstd
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy strict-origin-when-cross-origin
    }
}
```

> **Collision:** `handle /ws/relay` → `:21119` steals Web Remote’s relay path. Use the Web Remote snippet above (no `/ws/relay` → Go), or separate hostnames for native WSS vs the console.

Upstream to BetterDesk is always **`http://`** unless you enabled Enterprise TLS on Go ports (unusual behind an external proxy).

#### Client settings (critical — avoids Caddy `308` and `initiator_not_registered`)

| Field | Value |
|-------|--------|
| ID / Relay server | `desk.example.com` (no `ws://` prefix) |
| API server | `https://desk.example.com:21121` **or** the public API URL you expose (HTTPS if Caddy terminates TLS) |
| Use WebSocket | On |

**Do not** configure the client with plain `ws://desk.example.com/ws/id`. Caddy’s automatic HTTPS redirects `ws://` → `https://` with **HTTP 308**, and the RustDesk client reports `WebSocket connection failed (HTTP error: 308)`. Always use **WSS** (the client builds `wss://` when the ID host is HTTPS / WebSocket mode behind TLS).

Also set on the BetterDesk host:

```env
TRUST_PROXY=Y
TRUSTED_PROXIES=<caddy-LAN-IP>/32
HOST=0.0.0.0
```

Without `TRUST_PROXY`, Go may key WebSocket sessions by the proxy’s LAN IP instead of the client’s public IP, so PunchHole sees `initiator_not_registered` even after a successful `/ws/id` upgrade ([#294](https://github.com/UNITRONIX/BetterDesk/issues/294), [#276](https://github.com/UNITRONIX/BetterDesk/issues/276)).

Reload Caddy after editing:

```bash
sudo systemctl reload caddy
# or: caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

---

## Desktop WebSocket Mode checklist (not server WebSocket-only)

BetterDesk supports RustDesk **desktop WebSocket Mode** (WSS signal/relay). There is **no** server toggle that disables native TCP/UDP listeners — “WS-only” means client settings plus optional firewall/proxy choices. Desktop WSS maturity is in **≥ 3.4.0** (proxy session keys, mixed-transport reject, full WS relay frames); **3.4.2** fixed Web Remote after the enrollment gate, not desktop WS-only. FAQ: [#344](https://github.com/UNITRONIX/BetterDesk/issues/344).

### Two stacks — do not mix

| Stack | Client | Public paths | Upstream |
|-------|--------|--------------|----------|
| Native desktop WSS | RustDesk with `allow-websocket=Y` / “Use WebSocket” | `/ws/id`, optional `/ws/relay` | Go `:21118` / `:21119` (raw protobuf) |
| Web Remote | Browser RdClient | `/ws/rendezvous`, `/ws/relay` | Panel `:5000` → TCP `:21116` / `:21117` (TCP-framed) |

Never route `/ws/rendezvous` to Go. On **one hostname**, `/ws/relay` cannot cleanly serve both stacks — prefer the panel catch-all for Web Remote, or put native WSS on a **separate hostname** (examples below).

### Operator checklist

1. **Client:** WebSocket Mode on; ID host is an HTTPS domain so the client builds **`wss://`**. Do not put `ws://…/ws/id` in the ID field (Caddy auto-HTTPS → HTTP **308** — [#294](https://github.com/UNITRONIX/BetterDesk/issues/294)).
2. **Proxy:** `/ws/id` → `:21118`. For desktop relay WSS, `/ws/relay` → `:21119` only when Web Remote is not on that vhost (or use a second hostname).
3. **Go env:** `TRUST_PROXY=Y` and `TRUSTED_PROXIES=<proxy CIDR>`; `X-Real-IP` / `X-Forwarded-For` as **IP-only** ([#276](https://github.com/UNITRONIX/BetterDesk/issues/276), [#294](https://github.com/UNITRONIX/BetterDesk/issues/294)).
4. **Homogeneous transport:** both peers must use WebSocket Mode for relay — mixed WSS (`:21119`) + native TCP/TLS (`:21117`) is rejected ([#290](https://github.com/UNITRONIX/BetterDesk/issues/290)).
5. **Optional hardening:** firewall WAN `21116` TCP/UDP and `21117` if you want traffic only on 443 WSS — BetterDesk does **not** enforce this.
6. **Config gap:** panel key/generator TOML does **not** emit `allow-websocket` — set it in a custom client build or manually.

### Separate hostnames (recommended when both Web Remote and native WSS are needed)

| Hostname | Role | Key proxy routes |
|----------|------|------------------|
| `console.example.com` | Panel + Web Remote | `/` and `/ws/*` → panel `:5000` (no `/ws/id` → Go required) |
| `desk.example.com` | Native desktop WSS | `/ws/id` → `:21118`, `/ws/relay` → `:21119`; set client ID/relay to this host |

Set `PANEL_PUBLIC_HOST`, `PUBLIC_SERVER_ID`, and related vars under [Split DNS / multiple hostnames](#split-dns--multiple-hostnames) (or **Settings → Public client endpoints**).

### How to verify

1. Desktop client stays online via `wss://YOUR_DOMAIN/ws/id` (proxy → `:21118`).
2. Two WebSocket Mode peers can connect (relay or punch as applicable).
3. Behind a proxy, Go logs show `effective=<client-ip>:<non-zero-port>` (not `:0`).
4. If Web Remote is used, browser `/ws/rendezvous` hits panel `:5000`, not Go.

More Nginx detail and troubleshooting: [HTTPS_SETUP.md — RustDesk Client WSS Through Nginx](HTTPS_SETUP.md#rustdesk-client-wss-through-nginx).

---

## Nginx configuration

Full examples with WebSocket timeouts and RustDesk WSS paths are in [HTTPS_SETUP.md — Option 4](HTTPS_SETUP.md#option-4-reverse-proxy-with-nginx) and [RustDesk Client WSS Through Nginx](HTTPS_SETUP.md#rustdesk-client-wss-through-nginx).

Critical rules:

1. **Never** route `/ws/rendezvous` to Go `:21118` — that path belongs to the panel Web Remote bridge (`:5000` → hbbs TCP).
2. **`location = /ws/id`** (and optional native **`location = /ws/relay`**) must appear **before** generic `location ~ ^/ws/` (panel routes). Native `/ws/relay` → `:21119` conflicts with Web Remote on the same hostname.
3. Set `proxy_set_header X-Forwarded-Proto $scheme` and `X-Forwarded-For`.
4. Use `proxy_buffering off` and long `proxy_read_timeout` for `/ws/` paths (86400s for web remote).
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

**Docker:** panel saves to `/app/data/public-endpoints.env` on the `console-data` volume (survives container recreate). Non-empty Compose `environment:` values for these keys take precedence over the file. Do not set empty `PUBLIC_*=` keys in compose. On first read after upgrade, values are migrated from console `.env` if the durable file is empty.

See [RustDesk Client Deployment](RUSTDESK_CLIENT_DEPLOYMENT.md).

---

## Firewall and ports

### Through the reverse proxy (HTTPS on `:443`)

- Panel HTTP, Web Remote (`/ws/rendezvous`, `/ws/relay`), operator chat, MeshAgent `.ashx` paths → proxy to `:5000`
- RustDesk WSS (optional) → proxy `/ws/id` → `:21118`; native `/ws/relay` → `:21119` only when Web Remote is not needed on that hostname (path collision)
MeshAgent web-cert pin: when Go still has `TLS_CERT` (or you keep signal TLS), set **`MESH_WEB_CERT_FILE`** to the public certificate the agent sees on `:443` (e.g. Let's Encrypt fullchain). See [MeshAgent onboarding](../features/MESHAGENT_ONBOARDING.md#behind-an-external-reverse-proxy-nginx--npm--caddy). Do not confuse this with `MESH_AGENT_CERT_FILE` (`.msh` `ServerID`).

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
| Web Remote WS closes with **1000** right after first binary frame (payload starts with `65 01`) | `/ws/rendezvous` (or `/ws/relay`) proxied to Go WSS `:21118`/`:21119` | Route those paths to panel `:5000`; never put `/ws/rendezvous` on the Go signal matcher ([#329](https://github.com/UNITRONIX/BetterDesk/issues/329)) |
| WSS `401` / `403` on `/ws/id` | Routed to panel `:5000` instead of Go | Use exact `/ws/id` → `:21118` before catch-all |
| Client log `HTTP error: 308` on `ws://…/ws/id` | Plain WS hit Caddy HTTPS redirect | Use WebSocket Mode with HTTPS/WSS host; never `ws://` when Caddy forces HTTPS ([#294](https://github.com/UNITRONIX/BetterDesk/issues/294)) |
| WSS upgrade OK but PunchHole `initiator_not_registered` | Proxy IP used as peer key / no RegisterPeer | `TRUST_PROXY=Y` + `TRUSTED_PROXIES`; ensure client completes registration (service on, or logged-in token / TCP RegisterPk) |
| `AlertReceived(UnrecognisedName)` | TLS cert hostname mismatch | Fix cert on proxy for client hostname |
| Double TLS / protocol error | Proxy uses `https://` upstream | Upstream must be `http://127.0.0.1:…` unless Enterprise TLS on Go |
| Panel works but clients timeout | Firewall | Open 21116 UDP/TCP, 21117 TCP |
| MeshAgent `bad web cert hash` | Agent sees proxy LE cert; Go hashes different `TLS_CERT` | Set `MESH_WEB_CERT_FILE` to the public fullchain, or unset `TLS_CERT` / `MESH_WEB_CERT_FILE` to skip validation |
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
