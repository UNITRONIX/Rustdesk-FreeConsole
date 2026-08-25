# 🚀 BetterDesk Docker Quick Start

Get BetterDesk running in **30 seconds** with pre-built images from GitHub Container Registry (ghcr.io).

Versioned tags match [CHANGELOG.md](../../CHANGELOG.md) and git releases (e.g. `3.0.0`, git tag `v3.0.0`). The quick-start compose file defaults to the current release; override with `BETTERDESK_IMAGE_TAG`.

## Prerequisites

- Docker 20.10+
- docker-compose v2.0+ (or `docker compose` plugin)
- Open ports: 21115-21119, 21121, 5000 (official single-container layout)

## 🏃 Quick Start

### One-line installer (automated)

Fully automated: installs Docker if missing, downloads the **official all-in-one** compose + image (`ghcr.io/unitronix/betterdesk`), auto-detects relay IP, configures firewall, waits for health checks, prints credentials.

```bash
curl -fsSL https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/install.sh | sudo bash
```

**Common variants:**

```bash
# Legacy two-container layout (server + console images)
curl -fsSL .../install.sh | sudo bash -s -- --split

# LAN-only deployment
curl -fsSL .../install.sh | sudo bash -s -- --relay-mode local

# Pin image version + set admin password
curl -fsSL .../install.sh | sudo bash -s -- --version 3.3.112 --admin-password 'YourSecurePass'

# Uninstall (keep data volumes)
curl -fsSL .../install.sh | sudo bash -s -- --uninstall

# Uninstall and delete volumes
curl -fsSL .../install.sh | sudo bash -s -- --uninstall --purge
```

Files are stored under `/opt/betterdesk/docker/` (`docker-compose.yml`, `.env`).

### Quick Start (3 Commands) — official single container

```bash
# 1. Download docker-compose file
curl -fsSL https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/docker-compose.quick.single.yml -o docker-compose.yml

# 2. Pull pinned image and start (default tag matches VERSION in repo)
docker compose pull
docker compose up -d

# 3. Get admin password
docker compose exec betterdesk betterdesk-show-admin-credentials
```

**Done!** Open **http://localhost:5000** (plain HTTP — not `https://`) and log in with `admin` / (password from step 3). The default image does not terminate TLS on port 5000; using `https://…:5000` often yields Firefox `SSL_ERROR_RX_RECORD_TOO_LONG` — see [DOCKER_TROUBLESHOOTING.md](DOCKER_TROUBLESHOOTING.md#problem-browser-shows-ssl_error_rx_record_too_long-or-chrome-err_ssl_protocol_error).

If `cat /opt/rustdesk/.admin_credentials` returns **Permission denied**, use `betterdesk-show-admin-credentials` above (or `docker compose exec -u betterdesk betterdesk …`) — see [DOCKER_TROUBLESHOOTING.md](DOCKER_TROUBLESHOOTING.md#problem-permission-denied-reading-admin_credentials).

### Legacy split layout (two images)

```bash
curl -fsSL https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/docker-compose.quick.yml -o docker-compose.yml
docker compose pull && docker compose up -d
docker compose exec console betterdesk-show-admin-credentials
```

Split layout uses API port **21114**; the official single container uses **21121**.

### Pin or change image version

```bash
# Explicit version (recommended for production)
export BETTERDESK_IMAGE_TAG=3.0.0
docker compose pull && docker compose up -d

# Track rolling latest from main branch builds
export BETTERDESK_IMAGE_TAG=latest
docker compose pull && docker compose up -d
```

Browse tags: GitHub repo → **Packages** → `betterdesk` (official), or legacy `betterdesk-server` / `betterdesk-console`, or [releases](https://github.com/UNITRONIX/BetterDesk/releases).

---

## 📦 What Gets Installed (single container — default)

| Port | Description |
|------|-------------|
| 21116 TCP/UDP | Signal server (device registration) |
| 21117 | Relay server (connections) |
| 21121 | HTTP API (RustDesk client + REST) |
| 5000 | Web management panel |

Legacy split layout exposes API on **21114** instead of 21121.

## 🔧 Configuration

### Relay Address for Docker Hosts

If clients can register but remote sessions fail with `Failed to connect via relay server`, set the relay address that clients can actually reach. In Docker quick images, the server may see its internal container address, which is not reachable from RustDesk clients.

```bash
# Public server
RELAY_SERVERS=203.0.113.10:21117 docker compose up -d

# LAN-only server
RELAY_SERVERS=192.168.1.10:21117 docker compose up -d
```

Use the Docker host address, not the container IP. Make sure TCP port `21117` is open and forwarded to the host.

### Public Client Endpoints (survive container recreate)

Settings → **Public client endpoints** (ID server, relay, API URL) are stored on the **`console-data` volume** at `/app/data/public-endpoints.env`. They survive `docker compose pull`, `up -d`, and `--force-recreate`.

Alternatively, set them declaratively in compose (non-empty values override the panel file):

```yaml
environment:
  - PUBLIC_SERVER_ID=gateway.example.net
  - PUBLIC_RELAY_SERVER=gateway.example.net
  - PUBLIC_API_URL=https://api.example.net:21121
```

Do **not** add empty `PUBLIC_*=` entries — leave the keys unset when using the panel. See [REVERSE_PROXY.md](../setup/REVERSE_PROXY.md#split-dns--multiple-hostnames).

### Custom Admin Password

```bash
# Set before first start, while the Docker volumes are still empty
ADMIN_PASSWORD=YourSecurePass123 docker compose up -d
```

`ADMIN_PASSWORD` only seeds the first admin account. If the container has
already created the admin user in `db_v2.sqlite3` (or PostgreSQL), changing the
environment variable on restart will not overwrite the stored password. Use
the panel password reset flow, or recreate the Docker volumes for a fresh
install.

### PostgreSQL Instead of SQLite

```yaml
# Add to docker-compose.yml
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: betterdesk
      POSTGRES_USER: betterdesk
      POSTGRES_PASSWORD: secretpassword
    volumes:
      - postgres-data:/var/lib/postgresql/data

  server:
    environment:
      - DB_URL=postgres://betterdesk:secretpassword@postgres:5432/betterdesk
    depends_on:
      - postgres

volumes:
  postgres-data:
```

### SSL/TLS

By default the web panel is **HTTP on port 5000**. Do not open `https://…:5000` unless you have enabled panel HTTPS or put a reverse proxy in front — otherwise browsers report `SSL_ERROR_RX_RECORD_TOO_LONG` / `ERR_SSL_PROTOCOL_ERROR` ([troubleshooting](DOCKER_TROUBLESHOOTING.md#problem-browser-shows-ssl_error_rx_record_too_long-or-chrome-err_ssl_protocol_error)).

See [HTTPS_SETUP.md](../setup/HTTPS_SETUP.md) for full instructions.

Quick self-signed cert:
```bash
mkdir -p certs
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=betterdesk.local"
```

---

## 🔄 Updates

```bash
# Stay on the same pinned tag (default 3.0.0)
docker compose pull
docker compose up -d

# Move to a newer release after it is published on ghcr.io
export BETTERDESK_IMAGE_TAG=<new-version>   # e.g. 3.0.0-beta or 3.0.0
docker compose pull && docker compose up -d
```

**Stable vs development channel:** Settings → Updates → Update channel does **not** switch GHCR images. Change the image tag instead:

| Channel | Typical `BETTERDESK_IMAGE_TAG` |
|---------|--------------------------------|
| Stable (`main`) | `latest` or a release version (e.g. `3.4.3`) |
| Development (`dev`) | `dev` |

Then: `docker compose pull && docker compose up -d`. In-app “Install update” stays disabled for official image deployments.

## 🗑️ Uninstall

```bash
docker compose down -v  # -v removes volumes (data)
```

## 📊 Check Status

```bash
# All services running?
docker compose ps

# Logs (single container)
docker compose logs betterdesk

# Health check (single container)
curl http://localhost:21121/api/health
```

Legacy split: `docker compose logs server` / `console`, health on `:21114`.

---

## MACVLAN (dedicated LAN IP)

Use this when the stack must listen on a **macvlan** address (no host port mappings).

**Single container (recommended):**

```bash
docker network create -d macvlan \
  --subnet=192.168.1.0/24 --gateway=192.168.1.1 \
  -o parent=eth0 LAN

export MACVLAN_IPV4=192.168.1.51
export RELAY_SERVERS=${MACVLAN_IPV4}:21117
curl -fsSL https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/docker-compose.quick.single.macvlan.yml -o docker-compose.yml
docker compose pull && docker compose up -d
```

**Legacy split:** `docker-compose.quick.macvlan.yml`

Web console: `http://MACVLAN_IPV4:5000`

### Upgrading a custom macvlan compose (issue #186)

If you customized an older quick-start file before **3.0.0**, apply these changes after pulling new images:

| Setting | Required in 3.0.0+ |
|---------|-------------------|
| `depends_on` | `condition: service_started` — **not** `service_healthy` |
| Server healthcheck | Keep enabled, or remove `service_healthy` from `depends_on` |
| Console `DB_PATH` | `/app/data/db_v2.sqlite3` |
| Server `AUTH_DB_PATH` | `/app/data/auth.db` only for legacy panel sync |
| Server volume | `console-data:/app/data:ro` |
| `network_mode: service:server` | Use `127.0.0.1` in `BETTERDESK_API_URL`, `WS_HBBS_HOST`, `WS_HBBR_HOST` (Docker DNS is unavailable) |
| Image tag | Pin `BETTERDESK_IMAGE_TAG` (e.g. `3.2.14`), not unversioned `latest` |

**Symptom:** server logs look healthy but the console never starts — check `docker compose ps -a` and `docker compose logs console`. The usual cause is `depends_on: service_healthy` while the server healthcheck is disabled.

Optional: copy `docker-compose.quick.macvlan.yml` from this repo as a maintained baseline.

---

## ❓ Troubleshooting

### "denied" or "pull access denied" when starting

This means the pre-built images are not yet published to GitHub Container Registry.

**Solution A — Build locally (recommended):**
```bash
# Use the full docker-compose.yml which builds images from source
git clone https://github.com/UNITRONIX/Rustdesk-FreeConsole.git
cd Rustdesk-FreeConsole
docker compose -f docker-compose.yml up -d --build
```

**Solution B — Wait for images to be published:**

The repository maintainer needs to trigger the Docker publish workflow:
1. Go to: GitHub repo → Actions → "Build & Publish Docker Images"
2. Click "Run workflow" → Branch: main → Click "Run workflow"
3. Wait ~10 minutes for images to build
4. Once images are published, retry `docker compose up -d`

**Solution C — Authenticate (if repo is private):**
```bash
# Create a GitHub Personal Access Token with 'read:packages' scope
docker login ghcr.io -u YOUR_GITHUB_USERNAME -p YOUR_GITHUB_TOKEN
docker compose up -d
```

### "Cannot connect to devices"

1. Check firewall allows ports 21116-21117
2. Verify server is healthy: `curl http://localhost:21114/api/health`
3. Check the advertised relay address: `docker compose logs server | grep 'relay='`
4. If logs show a Docker/container IP such as `10.x.x.x` or `172.x.x.x`, restart with `RELAY_SERVERS=YOUR_HOST_IP:21117 docker compose up -d`

### "Web console shows 0 devices"

1. Verify API key sync: `docker compose exec console cat /opt/rustdesk/.api_key`
2. Restart console: `docker compose restart console`

### "Connection refused on port 21116"

1. Wait 30 seconds for server to start
2. Check server health: `docker compose ps`
3. View server logs: `docker compose logs server`

### Need more help?

See [DOCKER_TROUBLESHOOTING.md](../docker/DOCKER_TROUBLESHOOTING.md) for advanced issues.

---

## 🏗️ Build from Source (Advanced)

If you need custom modifications:

```bash
git clone https://github.com/UNITRONIX/Rustdesk-FreeConsole.git
cd Rustdesk-FreeConsole
docker compose -f docker-compose.yml up -d --build
```

---

## 📝 RustDesk Client Configuration

Configure your RustDesk clients with:

| Setting | Value |
|---------|-------|
| ID Server | `YOUR_SERVER_IP:21116` |
| Relay Server | `YOUR_SERVER_IP:21117` |
| API Server | `http://YOUR_SERVER_IP:21121` |
| Key | (get from web console Settings page) |

Or scan the QR code from the web console Settings page.

For a public hostname that differs from the Docker service name (`betterdesk-server` / `127.0.0.1`), configure **Settings → Public client endpoints** (persisted on the `console-data` volume) or set `PUBLIC_*` in compose — see [Public Client Endpoints](#public-client-endpoints-survive-container-recreate).
