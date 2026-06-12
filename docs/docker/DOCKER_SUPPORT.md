# 🐳 Docker Installation Guide - BetterDesk Console

Complete guide for running BetterDesk Console with RustDesk in Docker containers.

> **Images**: Pre-built images are published to [GitHub Container Registry](https://github.com/UNITRONIX/BetterDesk/pkgs/container/betterdesk-server) (`ghcr.io/unitronix/…`) with version tags aligned to [CHANGELOG.md](../../CHANGELOG.md). Use [DOCKER_QUICKSTART.md](DOCKER_QUICKSTART.md) and `docker-compose.quick.yml` to pull by tag. For custom changes, build locally with `docker compose build` or `docker compose up --build` (not on Docker Hub).

## Table of Contents

- [Quick Start (Recommended)](#quick-start-recommended)
- [Docker Compose Setup](#docker-compose-setup)
- [Manual Docker Setup](#manual-docker-setup)
- [Troubleshooting](#troubleshooting)
- [Migration from Native Install](#migration-from-native-install)

---

## Quick Start (Recommended)

### Option 1: Automatic Setup (Easiest)

```bash
# Clone repository
git clone https://github.com/UNITRONIX/Rustdesk-FreeConsole.git
cd Rustdesk-FreeConsole

# Run quick setup
chmod +x docker-quickstart.sh
./docker-quickstart.sh
```

This script will:
- ✅ Create docker-compose environment
- ✅ Set up data directories  
- ✅ Ask about existing RustDesk data import
- ✅ Start all services
- ✅ Show access URLs

### Option 2: Custom Installation

```bash
# Use the Docker installer with custom options
chmod +x install-docker.sh
sudo ./install-docker.sh
```

This installer provides:
- ✅ Path selection for existing RustDesk data
- ✅ Container vs volume installation modes
- ✅ Database migration
- ✅ Binary deployment
- ✅ Service configuration

### 1. Create Project Directory

```bash
mkdir -p /opt/betterdesk-docker
cd /opt/betterdesk-docker
```

### 2. Create docker-compose.yml

```yaml
version: '3.8'

services:
  # RustDesk HBBS (Signal Server) with BetterDesk API
  hbbs:
    image: rustdesk/rustdesk-server:latest
    container_name: betterdesk-hbbs
    command: hbbs -k _ --api-port 21114
    ports:
      - "21115:21115"
      - "21116:21116"
      - "21116:21116/udp"
      - "21114:21114"       # API port for BetterDesk
    volumes:
      - ./data:/root
    environment:
      - ALWAYS_USE_RELAY=N
    networks:
      - betterdesk-net
    restart: unless-stopped

  # RustDesk HBBR (Relay Server)
  hbbr:
    image: rustdesk/rustdesk-server:latest
    container_name: betterdesk-hbbr
    command: hbbr -k _
    ports:
      - "21117:21117"
    volumes:
      - ./data:/root
    networks:
      - betterdesk-net
    restart: unless-stopped
    depends_on:
      - hbbs

  # BetterDesk Web Console
  console:
    build:
      context: ./console
      dockerfile: Dockerfile
    container_name: betterdesk-console
    ports:
      - "5000:5000"
    volumes:
      - ./data:/opt/rustdesk:ro    # Read-only access to RustDesk data
      - ./console-data:/app/data   # Console-specific data
    environment:
      - DB_PATH=/opt/rustdesk/db_v2.sqlite3
      - API_KEY_PATH=/opt/rustdesk/.api_key
      - PUB_KEY_PATH=/opt/rustdesk/id_ed25519.pub
      - FLASK_SECRET_KEY=${FLASK_SECRET_KEY:?Set FLASK_SECRET_KEY in .env or export it}
    networks:
      - betterdesk-net
    restart: unless-stopped
    depends_on:
      - hbbs

networks:
  betterdesk-net:
    driver: bridge
```

### 3. Create Console Dockerfile

```bash
mkdir -p console
cat > console/Dockerfile << 'EOF'
FROM python:3.11-slim

WORKDIR /app

# Install dependencies
RUN apt-get update && apt-get install -y \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Copy application files
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create data directory
RUN mkdir -p /app/data

EXPOSE 5000

# Run with gunicorn for production
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "app:app"]
EOF
```

### 4. Create Console Requirements

```bash
cat > console/requirements.txt << 'EOF'
flask>=2.0.0
flask-wtf>=1.0.0
flask-limiter>=3.0.0
bcrypt>=4.0.0
markupsafe>=2.1.0
gunicorn>=21.0.0
requests>=2.28.0
EOF
```

### 5. Copy Console Files

```bash
# Clone repository first if you haven't
git clone https://github.com/UNITRONIX/Rustdesk-FreeConsole.git /tmp/betterdesk

# Copy web files
cp -r /tmp/betterdesk/web/* console/
```

### 6. Start Services

```bash
# Generate a random secret key
export FLASK_SECRET_KEY=$(openssl rand -hex 32)

# Start all services
docker-compose up -d

# Check status
docker-compose ps
docker-compose logs -f
```

### 7. Access Console

- **Web Console**: http://your-server-ip:5000
- **Default Login**: admin / (check logs for password)

---

## Docker Compose Setup (Full)

### Complete docker-compose.yml with All Options

```yaml
version: '3.8'

services:
  hbbs:
    image: rustdesk/rustdesk-server:latest
    container_name: betterdesk-hbbs
    hostname: betterdesk-hbbs
    command: hbbs -k _ --api-port 21114
    ports:
      - "21115:21115"           # TCP hole punching
      - "21116:21116/tcp"       # TCP relay
      - "21116:21116/udp"       # UDP hole punching
      - "21114:21114"           # HTTP API
    volumes:
      - betterdesk-data:/root
    environment:
      - ALWAYS_USE_RELAY=N
      - ENCRYPTED_ONLY=1
      - DB_URL=./db_v2.sqlite3
    networks:
      betterdesk-net:
        aliases:
          - hbbs
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "nc", "-z", "localhost", "21116"]
      interval: 30s
      timeout: 10s
      retries: 3

  hbbr:
    image: rustdesk/rustdesk-server:latest
    container_name: betterdesk-hbbr
    hostname: betterdesk-hbbr
    command: hbbr -k _
    ports:
      - "21117:21117"           # Relay port
    volumes:
      - betterdesk-data:/root
    networks:
      betterdesk-net:
        aliases:
          - hbbr
    restart: unless-stopped
    depends_on:
      hbbs:
        condition: service_healthy

  console:
    build:
      context: ./console
      dockerfile: Dockerfile
    container_name: betterdesk-console
    hostname: betterdesk-console
    ports:
      - "5000:5000"
    volumes:
      - betterdesk-data:/opt/rustdesk:ro
      - console-data:/app/data
    environment:
      - DB_PATH=/opt/rustdesk/db_v2.sqlite3
      - API_KEY_PATH=/opt/rustdesk/.api_key
      - PUB_KEY_PATH=/opt/rustdesk/id_ed25519.pub
      - HBBS_API_URL=http://hbbs:21114/api
      - FLASK_SECRET_KEY=${FLASK_SECRET_KEY}
      - FLASK_ENV=production
    networks:
      - betterdesk-net
    restart: unless-stopped
    depends_on:
      - hbbs
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  betterdesk-data:
    driver: local
  console-data:
    driver: local

networks:
  betterdesk-net:
    driver: bridge
    ipam:
      config:
        - subnet: 172.28.0.0/16
```

---

## Using Pre-built BetterDesk Binaries in Docker

If you want to use the enhanced HBBS with ban enforcement:

### 1. Custom Dockerfile for HBBS

```dockerfile
FROM debian:bullseye-slim

WORKDIR /opt/rustdesk

# Install dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy precompiled binaries
COPY hbbs-v8-api /opt/rustdesk/hbbs
COPY hbbr-v8-api /opt/rustdesk/hbbr
RUN chmod +x /opt/rustdesk/hbbs /opt/rustdesk/hbbr

# Create data directory
RUN mkdir -p /root

WORKDIR /root

EXPOSE 21115 21116 21116/udp 21117 21114

ENTRYPOINT ["/opt/rustdesk/hbbs"]
CMD ["-k", "_", "--api-port", "21114"]
```

### 2. Build and Run

```bash
# Copy binaries from repository
cp hbbs-patch/bin-with-api/hbbs-v8-api ./hbbs-v8-api
cp hbbs-patch/bin-with-api/hbbr-v8-api ./hbbr-v8-api

# Build custom image
docker build -t betterdesk-hbbs:v8 -f Dockerfile.hbbs .

# Update docker-compose.yml to use custom image
# Replace: image: rustdesk/rustdesk-server:latest
# With:    image: betterdesk-hbbs:v8
```

---

## Manual Docker Setup

### Individual Container Commands

```bash
# Create network
docker network create betterdesk-net

# Create data volume
docker volume create betterdesk-data

# Run HBBS
docker run -d \
  --name betterdesk-hbbs \
  --network betterdesk-net \
  -p 21115:21115 \
  -p 21116:21116 \
  -p 21116:21116/udp \
  -p 21114:21114 \
  -v betterdesk-data:/root \
  rustdesk/rustdesk-server:latest \
  hbbs -k _ --api-port 21114

# Run HBBR
docker run -d \
  --name betterdesk-hbbr \
  --network betterdesk-net \
  -p 21117:21117 \
  -v betterdesk-data:/root \
  rustdesk/rustdesk-server:latest \
  hbbr -k _

# Run Console (after building)
docker run -d \
  --name betterdesk-console \
  --network betterdesk-net \
  -p 5000:5000 \
  -v betterdesk-data:/opt/rustdesk:ro \
  -e DB_PATH=/opt/rustdesk/db_v2.sqlite3 \
  -e FLASK_SECRET_KEY=$(openssl rand -hex 32) \
  betterdesk-console:latest
```

---

## Troubleshooting

### Issue: Installation Script Not Detecting Docker

**Symptom:**
```
✗ Could not detect current version
✗ Installation directory not found
```

**Solution:** The installation script is for native installations. For Docker, use docker-compose as shown above.

### Issue: Devices Show as Offline

**Cause:** Database missing `last_online` column.

**Solution:**
```bash
# Access HBBS container
docker exec -it betterdesk-hbbs /bin/sh

# Add missing column
sqlite3 /root/db_v2.sqlite3 "ALTER TABLE peer ADD COLUMN last_online TEXT;"
sqlite3 /root/db_v2.sqlite3 "ALTER TABLE peer ADD COLUMN is_deleted INTEGER DEFAULT 0;"

# Restart container
docker restart betterdesk-hbbs betterdesk-console
```

### Issue: Cannot Connect to API

**Solution:**
```bash
# Check if API is responding
docker exec betterdesk-hbbs curl -s http://localhost:21114/api/health

# Check logs
docker logs betterdesk-hbbs --tail 50

# Verify port mapping
docker port betterdesk-hbbs
```

### Issue: Console Cannot Access Database

**Solution:**
```bash
# Check volume mounts
docker inspect betterdesk-console | grep Mounts -A 20

# Verify database exists
docker exec betterdesk-hbbs ls -la /root/*.sqlite3

# Check permissions
docker exec betterdesk-console ls -la /opt/rustdesk/
```

### Viewing Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f hbbs
docker-compose logs -f console

# Last 100 lines
docker logs betterdesk-hbbs --tail 100
```

---

## Migration from Native Install

### 1. Backup Existing Data

```bash
sudo cp -r /opt/rustdesk /opt/rustdesk-backup
sudo cp -r /opt/BetterDeskConsole /opt/BetterDeskConsole-backup
```

### 2. Stop Native Services

```bash
sudo systemctl stop hbbs hbbr betterdesk
sudo systemctl disable hbbs hbbr betterdesk
```

### 3. Copy Data to Docker Volume

```bash
# Create directory for Docker data
mkdir -p /opt/betterdesk-docker/data

# Copy RustDesk data
sudo cp /opt/rustdesk/db_v2.sqlite3 /opt/betterdesk-docker/data/
sudo cp /opt/rustdesk/id_ed25519* /opt/betterdesk-docker/data/
sudo cp /opt/rustdesk/.api_key /opt/betterdesk-docker/data/

# Set permissions
sudo chown -R 1000:1000 /opt/betterdesk-docker/data
```

### 4. Update docker-compose.yml

Use bind mount instead of named volume:

```yaml
volumes:
  - /opt/betterdesk-docker/data:/root
```

### 5. Start Docker Services

```bash
cd /opt/betterdesk-docker
docker-compose up -d
```

---

## Security Considerations

### Production Recommendations

1. **Use HTTPS** - Put a reverse proxy (nginx/traefik) in front
2. **Limit Network Access** - Use firewall rules
3. **Change Default Password** - Immediately after first login
4. **Regular Backups** - Backup the data volume
5. **Update Regularly** - Pull latest images

### Nginx Reverse Proxy Example

```nginx
server {
    listen 443 ssl http2;
    server_name betterdesk.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/betterdesk.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/betterdesk.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Reverse Proxy with WSS (RustDesk Clients)

When BetterDesk runs in Docker and a reverse proxy (Nginx, Nginx Proxy Manager,
Caddy, Traefik) terminates HTTPS on the host, the **console** and **RustDesk WSS**
endpoints use different upstream ports.

| Public path | Host upstream | Container service | Purpose |
|-------------|---------------|-------------------|---------|
| `/` (panel) | `http://HOST:5000` | `console` | Web admin UI |
| `/ws/id` | `http://HOST:21118` | `server` (Go) | RustDesk signal / rendezvous WSS |
| `/ws/relay` | `http://HOST:21119` | `server` (Go) | RustDesk relay WSS |

Docker Compose publishes `21118` and `21119` on the host by default
(see `docker-compose.yml`). The proxy on the host should target **`127.0.0.1`**
or the host LAN IP — not the container name — when the proxy runs outside the
Docker bridge network.

**Do not** route `/ws/id` or `/ws/relay` to port `5000`. The console exposes
different WebSocket paths (`/ws/rendezvous`, chat, remote viewer, etc.).

Example nginx locations (add to the same `server` block as the panel):

```nginx
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
}

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
}
```

**Nginx Proxy Manager:** create one Proxy Host for your domain with the main
forward to `:5000` (Websockets ON), then add Custom Locations for `/ws/id` →
`:21118` and `/ws/relay` → `:21119` (Websockets ON on each). Use `http://`
backends unless Enterprise TLS is enabled on the Go server.

**Verify from the Docker host:**

```bash
curl -i -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://127.0.0.1:21118/ws/id
```

Expected: `HTTP/1.1 101 Switching Protocols`.

Full troubleshooting (TLS SNI errors, keepalive timeouts): see
[HTTPS Setup — RustDesk WSS](../setup/HTTPS_SETUP.md#rustdesk-client-wss-through-nginx).

---

**Updated:** January 2026
**Version:** v1.5.0
