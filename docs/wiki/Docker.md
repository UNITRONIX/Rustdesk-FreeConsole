# Docker Deployment

BetterDesk offers multiple Docker deployment options.

---

## Quick Start (Pre-built Images)

The fastest way to get started — no build required:

```bash
curl -fsSL https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/docker-compose.quick.yml \
  -o docker-compose.yml
docker compose up -d
```

Default access:
- **Web Console:** http://localhost:5000
- **Default admin:** `admin` / check container logs for password

```bash
# View generated admin password
docker compose logs console | grep "Admin password"
```

---

## Deployment Options

### Option 1: Multi-Container (Recommended for Production)

Separate containers for each service:

```bash
git clone https://github.com/UNITRONIX/BetterDesk.git
cd BetterDesk
docker compose up -d --build
```

**`docker-compose.yml`** runs 3 containers:
- `betterdesk-server` — Go server (signal + relay + API)
- `betterdesk-console` — Node.js web console
- Shared volume for database and keys

### Option 2: Single Container

All services in one container (simpler, good for testing):

```bash
docker compose -f docker-compose.single.yml up -d --build
```

Uses `supervisord` to run Go server + Node.js console in a single container.

> ⚠️ **Note:** In single-container mode, `SIGNAL_PORT=21116` is set explicitly to prevent conflict with `PORT=5000` (used by Node.js).

### Option 3: Interactive Docker Script

```bash
./betterdesk-docker.sh
```

Interactive menu with:
- New installation
- Update
- Migrate from existing RustDesk Docker
- Database migration (SQLite ↔ PostgreSQL)

---

## Ports

Expose the following ports in your Docker configuration:

```yaml
ports:
  - "21114:21114"   # Go API
  - "21115:21115"   # NAT test
  - "21116:21116"   # Signal (TCP)
  - "21116:21116/udp"  # Signal (UDP)
  - "21117:21117"   # Relay
  - "21118:21118"   # WS Signal
  - "21119:21119"   # WS Relay
  - "21121:21121"   # Client API (Node.js)
  - "5000:5000"     # Web Console
```

---

## Volumes

### Data Persistence

```yaml
volumes:
  betterdesk-data:
    driver: local
```

Persist these paths:
- `/data/` — Database files, keys, API key
- `/opt/BetterDeskConsole/data/` — Console database, auth

### Important Files in Volume

| File | Description |
|------|-------------|
| `id_ed25519` | Server private key |
| `id_ed25519.pub` | Server public key |
| `db_v2.sqlite3` | Go server database |
| `.api_key` | API authentication key |
| `auth.db` | Console user database |

> ⚠️ Never delete `id_ed25519` — all connected clients use this key. Regenerating it requires reconfiguring every client.

---

## PostgreSQL with Docker

### Add PostgreSQL Container

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: betterdesk
      POSTGRES_PASSWORD: your-secure-password
      POSTGRES_DB: betterdesk
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U betterdesk"]
      interval: 5s
      timeout: 5s
      retries: 5

  server:
    # ... existing config ...
    environment:
      DB_URL: postgres://betterdesk:your-secure-password@postgres:5432/betterdesk?sslmode=disable
    depends_on:
      postgres:
        condition: service_healthy

  console:
    # ... existing config ...
    environment:
      DB_TYPE: postgresql
      DATABASE_URL: postgres://betterdesk:your-secure-password@postgres:5432/betterdesk?sslmode=disable

volumes:
  postgres-data:
```

---

## Environment Variables

### Go Server Container

| Variable | Default | Description |
|----------|---------|-------------|
| `SIGNAL_PORT` | `21116` | Signal server port |
| `RELAY_PORT` | `21117` | Relay server port |
| `DB_URL` | `db_v2.sqlite3` | Database path or PostgreSQL DSN |
| `RELAY_SERVERS` | auto-detected | Relay server addresses |
| `API_KEY` | auto-generated | API authentication key |
| `CDAP_ENABLED` | `N` | Enable CDAP gateway |

### Node.js Console Container

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5000` | Web console port |
| `BETTERDESK_API_URL` | `http://server:21114/api` | Go API URL |
| `API_KEY` | from file | API key |
| `DB_TYPE` | `sqlite` | Database type |
| `DATABASE_URL` | (empty) | PostgreSQL DSN |
| `SESSION_SECRET` | auto-generated | Session encryption key |

---

## Building Images

### Build All Images

```bash
docker compose build
```

### Build Individual Images

```bash
# Go server
docker build -f Dockerfile.server -t betterdesk-server .

# Node.js console
docker build -f Dockerfile.console -t betterdesk-console .

# Single container (all-in-one)
docker build -t betterdesk .
```

---

## Monitoring

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f server
docker compose logs -f console
```

### Health Check

```bash
# Server health
curl http://localhost:21114/api/health

# Console health
curl http://localhost:5000
```

### Container Status

```bash
docker compose ps
```

---

## Migration from RustDesk Docker

If you have an existing RustDesk Docker deployment:

```bash
./betterdesk-docker.sh
# Choose option M — Migrate from RustDesk Docker
```

The migration:
1. Stops existing RustDesk containers
2. Copies `db_v2.sqlite3` and `id_ed25519` keys
3. Starts BetterDesk containers
4. Verifies data migration

See [[Migration]] for more details.

---

## Troubleshooting

### GHCR "denied" Error

If pre-built images from `ghcr.io` are not available:

```bash
# Option 1: Build locally
docker compose up -d --build

# Option 2: Authenticate with GitHub
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin
```

### DNS Resolution Failures During Build

Docker build on some hosts (AlmaLinux, CentOS) may fail DNS resolution. The Dockerfiles include retry logic for `apk add` commands. If issues persist:

```bash
# Add DNS to Docker daemon
echo '{"dns": ["8.8.8.8", "8.8.4.4"]}' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
```

### SELinux Volume Mount Issues

On RHEL/CentOS with SELinux:

```bash
# Option 1: Named volumes (recommended)
# Already used in docker-compose.yml

# Option 2: :z flag for bind mounts
volumes:
  - ./data:/data:z

# Option 3: Set context
sudo chcon -Rt svirt_sandbox_file_t ./data
```

### Port 5000 Conflict (Single Container)

If both Go server and Node.js try to bind port 5000, ensure `SIGNAL_PORT=21116` is set in the Go server environment. This is set automatically in `supervisord.conf` and `entrypoint.sh`.

---

## See also

- [[Installation]] — bare-metal alternative
- [[Panel Updates|Panel-Updates]] — GHCR image updates
- [GHCR package readme](https://github.com/UNITRONIX/BetterDesk/blob/main/docs/docker/GHCR_PACKAGE_README.md)
