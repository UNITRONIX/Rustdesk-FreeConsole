# BetterDesk Installation on Synology DSM

This guide covers installing BetterDesk on Synology NAS devices using Docker (Container Manager).

## Prerequisites

- **Synology NAS** with Docker/Container Manager support (DSM 7.0+)
- **Container Manager** package installed from Package Center
- **SSH access** to your NAS (optional, for advanced setup)
- At least **2GB RAM** available for containers

## Method 1: Portainer Installation (Recommended)

If you have Portainer installed on your Synology:

### Step 1: Install Portainer (if not already installed)

1. Open **Container Manager** → **Registry**
2. Search for `portainer/portainer-ce`
3. Download the `latest` tag
4. Create a container with:
   - Port: `9000:9000` (web UI)
   - Volume: `/docker/portainer:/data`
5. Start the container and access Portainer at `http://[NAS-IP]:9000`

### Step 2: Deploy BetterDesk Stack

1. In Portainer, go to **Stacks** → **Add stack**
2. Name: `betterdesk`
3. Paste the following docker-compose configuration:

```yaml
version: '3.8'

services:
  betterdesk:
    build:
      context: https://github.com/UNITRONIX/Rustdesk-FreeConsole.git
      dockerfile: Dockerfile
    container_name: betterdesk
    restart: unless-stopped
    ports:
      - "21114:21114"   # HTTP API
      - "21115:21115"   # NAT test
      - "21116:21116"   # Signal TCP/UDP
      - "21116:21116/udp"
      - "21117:21117"   # Relay
      - "21118:21118"   # WebSocket signal
      - "21119:21119"   # WebSocket relay
      - "5000:5000"     # Web Console
    volumes:
      - /volume1/docker/betterdesk/data:/opt/betterdesk/data
    environment:
      - ADMIN_PASSWORD=YourSecurePassword123!
      - DB_TYPE=sqlite
```

4. Click **Deploy the stack**

### Step 3: Access the Console

- Web Console: `http://[NAS-IP]:5000`
- Default login: `admin` / `YourSecurePassword123!`

---

## Method 2: Container Manager Only (No Portainer)

### Step 1: Download Images

1. Open **Container Manager** → **Registry**
2. Search for `golang` and download `1.22-bookworm`
3. Search for `node` and download `20-bookworm-slim`

### Step 2: Clone Repository via SSH

```bash
# SSH into your Synology
ssh admin@[NAS-IP]

# Create directory
sudo mkdir -p /volume1/docker/betterdesk
cd /volume1/docker/betterdesk

# Clone repository
git clone https://github.com/UNITRONIX/Rustdesk-FreeConsole.git .
```

### Step 3: Build Images

```bash
# Build the single container image
cd /volume1/docker/betterdesk
sudo docker build -t betterdesk:latest -f Dockerfile .
```

### Step 4: Create Container in Container Manager

1. Go to **Container Manager** → **Container** → **Create**
2. Image: `betterdesk:latest`
3. Container name: `betterdesk`
4. Enable auto-restart: **Yes**
5. Port Settings:
   | Local Port | Container Port | Type |
   |------------|----------------|------|
   | 21114 | 21114 | TCP |
   | 21115 | 21115 | TCP |
   | 21116 | 21116 | TCP |
   | 21116 | 21116 | UDP |
   | 21117 | 21117 | TCP |
   | 21118 | 21118 | TCP |
   | 21119 | 21119 | TCP |
   | 5000 | 5000 | TCP |

6. Volume Settings:
   | Folder | Mount Path |
   |--------|------------|
   | /volume1/docker/betterdesk/data | /opt/betterdesk/data |

7. Environment Variables:
   | Variable | Value |
   |----------|-------|
   | ADMIN_PASSWORD | YourSecurePassword123! |
   | DB_TYPE | sqlite |

8. Click **Done** to create the container

---

## Method 3: docker-compose via SSH

### Step 1: Prepare Files

```bash
# SSH into Synology
ssh admin@[NAS-IP]

# Create directories
sudo mkdir -p /volume1/docker/betterdesk/data
cd /volume1/docker/betterdesk

# Clone repository
git clone https://github.com/UNITRONIX/Rustdesk-FreeConsole.git .
```

### Step 2: Create docker-compose.yml

```bash
cat > docker-compose.synology.yml << 'EOF'
version: '3.8'

services:
  betterdesk:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: betterdesk
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./data:/opt/betterdesk/data
    environment:
      - ADMIN_PASSWORD=${ADMIN_PASSWORD:?Set ADMIN_PASSWORD before starting}
      - DB_TYPE=sqlite
      - TZ=Europe/Warsaw
EOF
```

### Step 3: Deploy

```bash
# Set admin password
export ADMIN_PASSWORD='YourSecurePassword123!'

# Build and start
sudo docker-compose -f docker-compose.synology.yml up -d --build

# Check logs
sudo docker logs -f betterdesk
```

---

## Firewall Configuration

If your Synology has a firewall enabled, allow these ports:

| Port | Protocol | Description |
|------|----------|-------------|
| 5000 | TCP | Web Console |
| 21114 | TCP | HTTP API |
| 21115 | TCP | NAT test |
| 21116 | TCP/UDP | Signal Server |
| 21117 | TCP | Relay Server |
| 21118 | TCP | WebSocket Signal |
| 21119 | TCP | WebSocket Relay |

**DSM Firewall Settings:**
1. **Control Panel** → **Security** → **Firewall**
2. Create rules to allow the ports above from your LAN

---

## RustDesk Client Configuration

Configure your RustDesk clients to connect:

1. Open RustDesk client
2. Go to **Settings** → **Network**
3. Set **ID Server**: `[NAS-IP]:21116`
4. Set **Relay Server**: `[NAS-IP]:21117`
5. Set **API Server**: `http://[NAS-IP]:21114`
6. Import the **Public Key** from the web console

---

## Updating BetterDesk

### Via SSH:
```bash
cd /volume1/docker/betterdesk
git pull
sudo docker-compose -f docker-compose.synology.yml up -d --build
```

### Via Portainer:
1. Go to **Stacks** → `betterdesk`
2. Click **Pull and redeploy**

---

## Troubleshooting

### Container won't start
```bash
# Check logs
sudo docker logs betterdesk

# Verify ports are free
sudo netstat -tlnp | grep -E '21114|21115|21116|21117|21118|21119|5000'
```

### Permission issues

Containers run as `betterdesk` with **UID/GID 10001** by default. On Synology bind mounts, set `PUID`/`PGID` to the DSM folder owner instead of forcing `chown` to 10001:

```yaml
environment:
  - PUID=1000013   # id -u of the share owner
  - PGID=1000001   # id -g of the share owner
```

Or align the host directory with the container identity:

```bash
# Default image identity
sudo chown -R 10001:10001 /volume1/docker/betterdesk/data

# Or match whatever PUID/PGID you set in compose
sudo chown -R "${PUID:-10001}:${PGID:-10001}" /volume1/docker/betterdesk/data
```

Do **not** use Compose `user:` — it breaks the entrypoint `su-exec` / volume-fix flow.

### Can't connect from RustDesk client
1. Verify firewall rules allow the ports
2. Check if your router forwards the ports (for external access)
3. Ensure the public key is correctly imported in the client

### DSM 7.2+ Container Manager issues
If Container Manager doesn't show build options:
1. Use SSH method to build images
2. Or use Portainer for full Docker functionality

---

## Resource Recommendations

| Deployment | RAM | CPU |
|------------|-----|-----|
| Small (< 50 devices) | 512MB | 1 core |
| Medium (50-200 devices) | 1GB | 2 cores |
| Large (200+ devices) | 2GB+ | 2+ cores |

---

## Support

- GitHub Issues: https://github.com/UNITRONIX/Rustdesk-FreeConsole/issues
- Documentation: https://github.com/UNITRONIX/Rustdesk-FreeConsole/tree/main/docs

