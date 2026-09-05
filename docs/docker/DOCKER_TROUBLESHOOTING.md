# 🚀 Docker Quick Start for BetterDesk Console

## Problem: "Pull Access Denied" for betterdesk-hbbs / betterdesk-hbbr

### Symptom
```
! Image betterdesk-hbbs:latest pull access denied for betterdesk-hbbs, repository does not exist
! Image betterdesk-hbbr:latest pull access denied for betterdesk-hbbr, repository does not exist
Error response from daemon: pull access denied for betterdesk-hbbr, repository does not exist
```

### Cause
BetterDesk images are **NOT published to Docker Hub**. They must be **built locally** from the provided Dockerfiles.

> **Note**: This issue is now fixed in the latest docker-compose.yml with `pull_policy: never`. If you still see this error, update your files.

### ✅ Solution

**Option 1: Use docker compose build (REQUIRED)**
```bash
# Build images locally first - THIS IS REQUIRED
docker compose build

# Then start services
docker compose up -d
```

**Option 2: Build and start in one command**
```bash
docker compose up -d --build
```

**Option 3: Use the quick setup script**
```bash
chmod +x docker-quickstart.sh
./docker-quickstart.sh
```

This is the expected behavior - the images are built from:
- `Dockerfile.hbbs` - Signal server with BetterDesk API
- `Dockerfile.hbbr` - Relay server
- `Dockerfile.console` - Web console

---

## Problem: "no such table: peer" Error

### Symptom
The Dashboard shows an error every few seconds:
```
Error loading devices: no such table: peer
```
Or HTTP 500 errors to `/api/*` endpoints.

### Cause
This happens when you're using **original RustDesk binaries** instead of **BetterDesk enhanced binaries**. The original binaries don't create the `peer` table with the columns BetterDesk Console expects.

**Root causes:**
1. Using an outdated Dockerfile that copies from `rustdesk/rustdesk-server:latest`
2. Not rebuilding images after updating the repository
3. Manual installation with original RustDesk binaries

### ✅ Solution

**For Docker users:**
```bash
# 1. Update repository to get latest Dockerfiles
git pull origin main

# 2. Remove old images
docker compose down
docker rmi betterdesk-hbbs:local betterdesk-hbbr:local 2>/dev/null || true

# 3. Rebuild with new BetterDesk binaries
docker compose build --no-cache

# 4. Start fresh
docker compose up -d

# 5. Wait 30 seconds for database to be created, then check
docker compose exec hbbs ls -la /root/db_v2.sqlite3
```

**For manual installation (Linux):**
```bash
# Use the fix command to replace binaries
sudo ./install-improved.sh --fix

# Or full reinstall
sudo ./install-improved.sh
```

The BetterDesk binaries in `hbbs-patch-v2/` include:
- HTTP API on port 21114
- Extended `peer` table with `is_banned`, `is_deleted`, `last_online` columns
- Device tracking and management features

---

## Problem: Build Fails on Oracle Cloud VM (Read-only resolv.conf)

### Symptom
```
/bin/sh: 1: cannot create /etc/resolv.conf: Read-only file system
target betterdesk-console: failed to solve: process "/bin/sh -c echo \"nameserver 8.8.8.8\" >> /etc/resolv.conf...
```

### Cause
Oracle Cloud VMs have `/etc/resolv.conf` managed by `oraclevcn` service and it's **read-only**. The Dockerfile tries to modify DNS settings which fails.

### ✅ Solution

**This is now fixed in the latest version.** The Dockerfile.console now checks if the file is writable before attempting to modify it:

```dockerfile
RUN if [ -w /etc/resolv.conf ] && ! grep -q "oraclevcn" /etc/resolv.conf 2>/dev/null; then \
        echo "nameserver 8.8.8.8" >> /etc/resolv.conf; \
        echo "nameserver 1.1.1.1" >> /etc/resolv.conf; \
    fi && \
    apt-get update && apt-get install -y ...
```

If you have an older version:
```bash
# Update to latest
git pull origin main

# Rebuild images
docker compose build --no-cache
docker compose up -d
```

**Alternative for Oracle Cloud (if DNS issues persist):**
```bash
# Configure Docker daemon to use Google DNS
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json > /dev/null <<EOF
{
    "dns": ["8.8.8.8", "1.1.1.1"]
}
EOF
sudo systemctl restart docker
```

---

## Problem: DNS Failure During Build (AlmaLinux/CentOS)

### Symptom
```
=> => # Temporary failure resolving 'deb.debian.org'
target betterdesk-console: failed to solve: ...exit code: 100
```

### Cause
Docker on some RHEL-based systems (AlmaLinux, CentOS, Rocky Linux) can have DNS resolution issues during build.

### ✅ Solutions

**Option 1: Configure Docker DNS (recommended)**
```bash
# Edit Docker daemon config
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json > /dev/null <<EOF
{
    "dns": ["8.8.8.8", "1.1.1.1"]
}
EOF

# Restart Docker
sudo systemctl restart docker

# Rebuild
docker compose build --no-cache
```

**Option 2: Use host network during build**
```bash
# Build with host network
docker build --network=host -f Dockerfile.console -t betterdesk-console:local .
docker build --network=host -f Dockerfile.hbbs -t betterdesk-hbbs:local .
docker build --network=host -f Dockerfile.hbbr -t betterdesk-hbbr:local .

# Then start normally
docker compose up -d
```

**Option 3: Disable IPv6 in Docker (if IPv6 issues)**
```bash
# Add to /etc/docker/daemon.json
{
    "dns": ["8.8.8.8", "1.1.1.1"],
    "ipv6": false
}
```

---

## Problem: Volume Mount Permission Denied (SELinux — AlmaLinux/RHEL/CentOS)

### Symptom
```
Error: EACCES: permission denied, open '/opt/rustdesk/db_v2.sqlite3'
Error: cannot open database file
```

Or containers fail to start with permission errors when using bind mounts.

### Cause
SELinux-enabled systems (AlmaLinux, RHEL, CentOS, Rocky Linux) require special volume mount options or SELinux context changes for bind mounts.

On Synology / NAS bind mounts, host folders are often owned by DSM UIDs that are **not** the image default `10001:10001`. Prefer setting `PUID`/`PGID` (see below) rather than Compose `user:`.

### ✅ Solutions

**Option 1: Use Named Volumes (recommended)**

The default docker-compose.yml uses named volumes which work correctly with SELinux:
```yaml
volumes:
  - rustdesk-data:/opt/rustdesk    # Named volume - SELinux compatible
  - console-data:/app/data         # Named volume - SELinux compatible
```

**Option 2: Set PUID/PGID for bind mounts (#376)**

Map the in-container `betterdesk` user to the host directory owner (linuxserver-style). Defaults remain `10001:10001`.

```yaml
environment:
  - PUID=1000013
  - PGID=1000001
```

Restart the stack after changing these values so the entrypoint can remount ownership. Avoid Compose `user:` — it interferes with `su-exec`.

**Option 3: Add `:z` flag for Bind Mounts (SELinux)**

If you must use bind mounts (host paths), add the `:z` suffix:
```yaml
volumes:
  - /opt/betterdesk:/opt/rustdesk:z     # :z makes it SELinux-compatible
  - /opt/console-data:/app/data:z
```

**Option 4: Apply SELinux Context Manually**
```bash
# Apply container-compatible SELinux context to directories
sudo chcon -Rt svirt_sandbox_file_t /path/to/data/directory

# Example for BetterDesk
sudo chcon -Rt svirt_sandbox_file_t /opt/betterdesk
sudo chcon -Rt svirt_sandbox_file_t /opt/console-data
```

**Option 5: Temporarily Disable SELinux (not recommended for production)**
```bash
# Set SELinux to permissive mode temporarily
sudo setenforce 0

# Start containers
docker compose up -d

# Re-enable SELinux
sudo setenforce 1
```

> **Note:** The `betterdesk-docker.sh` script automatically handles SELinux contexts for RHEL-based systems.

---

## Problem: Missing Admin Login Credentials

If you started BetterDesk Console using Docker Compose following "Option 2" and don't see admin login credentials in the logs, it means the **database migration was not automatically executed**.

## ✅ Quick Solution

### Step 1: Check container status
```bash
docker compose ps
docker compose logs betterdesk-console | grep -i admin
```

### Step 2: Run migration manually
```bash
# Run migration directly in the console container
docker compose exec betterdesk-console python3 -c "
import sqlite3
import secrets
import bcrypt
from datetime import datetime
import os

DB_PATH = '/opt/rustdesk/db_v2.sqlite3'
DEFAULT_ADMIN_USERNAME = 'admin'
DEFAULT_ADMIN_PASSWORD = secrets.token_urlsafe(12)

print('📦 Running BetterDesk Console migration...')

# Connect to database
conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

# Check if users table exists
cursor.execute(\"SELECT name FROM sqlite_master WHERE type='table' AND name='users'\")
if cursor.fetchone():
    print('ℹ️  Migration already applied')
    exit(0)

print('🔧 Creating authentication tables...')

# Create authentication tables
cursor.execute('''
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'viewer',
        created_at DATETIME NOT NULL,
        last_login DATETIME,
        is_active BOOLEAN NOT NULL DEFAULT 1
    )
''')

cursor.execute('''
    CREATE TABLE IF NOT EXISTS sessions (
        token VARCHAR(64) PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        last_activity DATETIME NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
''')

cursor.execute('''
    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        action VARCHAR(50) NOT NULL,
        device_id VARCHAR(100),
        details TEXT,
        ip_address VARCHAR(50),
        timestamp DATETIME NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
''')

# Check if admin already exists
cursor.execute('SELECT id FROM users WHERE username = ?', (DEFAULT_ADMIN_USERNAME,))
if cursor.fetchone():
    print('ℹ️  Admin user already exists')
else:
    # Create default admin
    print('👤 Creating default admin user...')
    salt = bcrypt.gensalt()
    password_hash = bcrypt.hashpw(DEFAULT_ADMIN_PASSWORD.encode('utf-8'), salt).decode('utf-8')
    
    cursor.execute('''
        INSERT INTO users (username, password_hash, role, created_at, is_active)
        VALUES (?, ?, 'admin', ?, 1)
    ''', (DEFAULT_ADMIN_USERNAME, password_hash, datetime.now()))
    
    print('✅ Created default admin user')
    print('')
    print('=' * 60)
    print('🔐 DEFAULT ADMIN CREDENTIALS:')
    print('=' * 60)
    print(f'   Username: {DEFAULT_ADMIN_USERNAME}')
    print(f'   Password: {DEFAULT_ADMIN_PASSWORD}')
    print('=' * 60)
    print('⚠️  IMPORTANT: Change this password after first login!')
    print('=' * 60)

conn.commit()
conn.close()
print('✅ Migration completed successfully')
"
```

### Step 3: Check the result
After running the above script you should see:
```
🔐 DEFAULT ADMIN CREDENTIALS:
============================================================
   Username: admin
   Password: XyZ1aB2cD3eF4g
============================================================
```

### Step 4: Login
1. Open browser: http://localhost:5000
2. Use credentials: `admin` / `generated-password`
3. **Immediately change password** in settings!

## 🐳 Automatic Solution (improved configuration)

To prevent this issue in the future, you can use the improved configuration:

### 1. Get improved files
Replace your current `Dockerfile.console` with the improved version that automatically runs migration.

### 2. Rebuild container
```bash
docker compose down
docker compose build betterdesk-console
docker compose up -d
```

The improved version automatically:
✅ Detects if database exists  
✅ Runs migration on first startup  
✅ Displays login credentials in container logs  
✅ Saves credentials to `/app/data/admin_credentials.txt` file

## 📋 Troubleshooting

### Problem: Permission denied reading `.admin_credentials`

**Symptom:** After install, this fails:

```bash
docker compose exec console sh -c 'cat /opt/rustdesk/.admin_credentials'
# cat: can't open '/opt/rustdesk/.admin_credentials': Permission denied
```

**Cause:** Hardened Docker images use `cap_drop: [ALL]`. `docker compose exec` runs as root, but without `CAP_DAC_OVERRIDE` root cannot read `.admin_credentials` (mode `0600`, owned by the `betterdesk` user). The web panel still works because Node.js runs as `betterdesk`.

**Fix (recommended):**

```bash
docker compose exec console betterdesk-show-admin-credentials
```

**Fix (works on images before the helper was added):**

```bash
docker compose exec -u betterdesk console sh -c 'cat /opt/rustdesk/.admin_credentials 2>/dev/null || cat /app/data/.admin_credentials'
```

**Do not** run `chmod 777` on the credentials file — that makes the bootstrap password world-readable.

If no file is found yet, wait for first boot to finish and check `docker compose logs server` for the bootstrap message. On a running installation, the file is only a recovery aid; it is not the database of users.

### Problem: Panel login fails but `/opt/rustdesk/.admin_credentials` looks correct (#385)

**Symptom:** Fresh Docker install (`docker-compose.single.yml`, `docker-compose.quick.yml`, or `install.sh`). You read the bootstrap password from `/opt/rustdesk/.admin_credentials` (or `betterdesk-show-admin-credentials`), but the web panel at `:5000` returns **Invalid username or password**.

**Cause:** On first boot without `ADMIN_PASSWORD`, the Go server and Node.js console could each generate a random password. The credentials file then did not match the password hash stored for the admin user. Fresh SQLite installations use the centralized `/opt/rustdesk/db_v2.sqlite3` store (and PostgreSQL installations use the primary PostgreSQL database); `auth.db` is only a legacy migration path.

**Also common:** wiping only the `/opt/rustdesk` bind mount or volume while keeping `/app/data` (`console-data`). An old `auth.db` forces legacy panel authentication with a stale password hash, while bootstrap regenerates `.admin_credentials` on the rustesk volume. Current `:dev` images fail fast on this split state at container start.

**Also common:** commenting out `INIT_ADMIN_PASS` / `DEFAULT_ADMIN_PASSWORD` / `ADMIN_PASSWORD` in `docker-compose*.yml`. `ADMIN_PASSWORD=… docker compose up -d` on the host only passes the password into the container when those `${ADMIN_PASSWORD}` lines are present in the compose file.

**Also common on ARM64:** the all-in-one image tag `ghcr.io/unitronix/betterdesk:dev` is published as **amd64-only**. Hosts running `linux/arm64` keep an older cached AIO layer (or fail to refresh), while `betterdesk-server` / `betterdesk-console` stay multi-arch. Prefer [docker-compose.quick.yml](../../docker-compose.quick.yml), build AIO locally, or use a multi-arch tip tag such as `dev-arm` when published.

**Workaround (existing broken install):**

```bash
# For a disposable/test installation, remove BOTH Docker stores:
docker compose down
# Named volumes:
docker compose down -v
# Bind mounts — wipe both directories, e.g.:
# rm -rf ./betterdesk-data/* ./betterdesk-console-data/*
ADMIN_PASSWORD='YourSecurePassword123' docker compose up -d
```

Do not delete only the `/opt/rustdesk` bind mount while keeping `console-data`: that is not a clean reset. Do not use a credentials file to overwrite an existing user's password; use the normal password-reset procedure instead.

**Fix:** Pull/rebuild current `:dev` images (or wait for the next GHCR tag). On ARM64 prefer the split layout images. The split entrypoints elect one creator for the shared credentials file and both services reuse it. Setting `ADMIN_PASSWORD` before first start remains the deterministic option — keep the `INIT_ADMIN_*` / `DEFAULT_ADMIN_*` / `ADMIN_PASSWORD` env mappings in your compose file. Check `docker logs` for `Bootstrap: INIT_ADMIN_PASS/DEFAULT_ADMIN_PASSWORD set=yes|no` (password itself is never logged).

### Problem: `betterdesk-show-admin-credentials: executable file not found`

**Symptom:** After `install.sh` or `docker compose exec … betterdesk-show-admin-credentials`:

```text
OCI runtime exec failed: exec failed: … executable file not found in $PATH
```

**Cause:** The running image is older than the helper (#195 / 3.2.17+). `install.sh` used to pin a stale default tag while compose defaults moved ahead (#299).

**Fix:**

```bash
# Pull the current tag (match VERSION / compose default), then recreate:
cd /opt/betterdesk/docker   # or your compose directory
# Ensure .env has BETTERDESK_IMAGE_TAG=<current VERSION>, e.g. 3.5.37
docker compose pull && docker compose up -d

# Official single-container service name:
docker compose exec betterdesk betterdesk-show-admin-credentials

# Until you can pull a newer image:
docker compose exec -u betterdesk betterdesk \
  sh -c 'cat /opt/rustdesk/.admin_credentials 2>/dev/null || cat /app/data/.admin_credentials'
```

For the legacy two-container layout, replace `betterdesk` with `console`.

### Problem: Password reset says `No such container: betterdesk-console`

**Symptom:** `betterdesk-docker.sh` → reset admin password fails with:

```text
Error response from daemon: No such container: betterdesk-console
```

**Cause:** Official install uses the all-in-one container named `betterdesk`. Older script paths always exec'd `betterdesk-console` (#299).

**Fix:** Update to a build that includes `resolve_panel_container`, or reset manually:

```bash
docker exec betterdesk node /app/scripts/reset-password.js 'YourNewPassword' admin
```

### Problem: Split layout console exits with `SQLITE_READONLY` / `readonly database`

**Symptom:** `betterdesk-console` logs:

```text
Failed to start server: SqliteError: attempt to write a readonly database
```

**Cause:** Legacy `docker-compose.quick.yml` briefly pointed `DB_PATH` at `/app/data/db_v2.sqlite3` on the console volume while the Go server mounts that volume read-only for `auth.db` sync — wrong path for the shared peer DB (#299).

**Fix:** Use current `docker-compose.quick.yml` (`DB_PATH=/opt/rustdesk/db_v2.sqlite3`), then:

```bash
docker compose pull && docker compose up -d
```

Fresh volumes are simplest. If you already wrote peers only into an orphan `/app/data/db_v2.sqlite3`, copy it into the shared Go data volume at `/opt/rustdesk/db_v2.sqlite3` before recreating, or re-enroll devices.

### Problem: All-in-one exits with `ENV_NTP_SERVERS` / supervisord format string error

**Symptom:** Fresh AIO container logs end with:

```text
Error: Format string '…NTP_SERVERS="%(ENV_NTP_SERVERS)s"…' for 'environment'
contains names ('ENV_NTP_SERVERS') which cannot be expanded.
```

**Cause:** `supervisord.conf` interpolates billing/NTP env vars for the Go server. Older images / Portainer stacks / bare `docker run` that omit `NTP_SERVERS`, `BILLING_MAX_CLOCK_SKEW_MS`, `BILLING_REQUIRE_SYNCED_CLOCK`, and `BILLING_TRUST_OS_NTP` crash at supervisord parse time (#299).

**Fix (current images):** entrypoint and Dockerfile supply defaults — pull/rebuild the AIO image and recreate the container.

**Workaround (until you can update the image):** add the vars to your compose/stack (official `docker-compose.quick.single.yml` already includes them), then:

```bash
cd /opt/betterdesk/docker   # or your compose directory
docker compose up -d --force-recreate
```

Or for a one-off:

```bash
docker run ... \
  -e NTP_SERVERS=pool.ntp.org,time.google.com,time.cloudflare.com \
  -e BILLING_MAX_CLOCK_SKEW_MS=2000 \
  -e BILLING_REQUIRE_SYNCED_CLOCK=1 \
  -e BILLING_TRUST_OS_NTP=Y \
  ghcr.io/unitronix/betterdesk:<tag>
```

### Problem: Browser shows `SSL_ERROR_RX_RECORD_TOO_LONG` (or Chrome “ERR_SSL_PROTOCOL_ERROR”)

**Symptom:** After a fresh Docker install or `docker compose pull`, Firefox Advanced details show:

```text
SSL_ERROR_RX_RECORD_TOO_LONG
The page you are trying to view cannot be shown because the authenticity
of the received data could not be verified.
```

Chrome/Edge often report `ERR_SSL_PROTOCOL_ERROR` for the same case.

**Cause:** The browser used **HTTPS** against a port that speaks plain **HTTP**. Official GHCR quick-start / all-in-one images serve the web panel as **HTTP on port 5000** by default (`HTTPS_ENABLED` is off). Common triggers (#299):

- Opening `https://<host>:5000` (bookmark, autocomplete, Portainer “Open”)
- Mapping host **443 → container 5000** and browsing `https://…` without a TLS terminator
- A reverse proxy that forwards TLS to the panel without terminating SSL

**Fix:**

1. Use **`http://<host>:5000`** (not `https://`).
2. Confirm the panel is up over HTTP:
   ```bash
   curl -v http://127.0.0.1:5000/health
   docker compose logs --tail=80
   ```
   Expect a healthy HTTP response and a startup banner showing **HTTP**.
3. Correct Portainer / compose port maps so host 443 is not pointed at the plain-HTTP panel port unless a proxy terminates TLS.

**If you need TLS:** put nginx / Traefik / Caddy in front, or enable panel HTTPS (`HTTPS_ENABLED` + certs) — see [DOCKER_QUICKSTART — SSL/TLS](DOCKER_QUICKSTART.md#ssltls) and [HTTPS_SETUP.md](../setup/HTTPS_SETUP.md).

### Problem: "Database not found"
```bash
# Check volumes
docker compose exec betterdesk-console ls -la /opt/rustdesk/

# Check if HBBS created database
docker compose exec hbbs ls -la /root/
```

### Problem: "bcrypt not available"
```bash
# Install bcrypt in container
docker compose exec betterdesk-console pip install bcrypt
```

### Problem: Container won't start
```bash
# Check logs of all containers
docker compose logs

# Check status
docker compose ps
```

## 🔧 Useful commands

```bash
# Check console container logs
docker compose logs -f betterdesk-console

# Access container
docker compose exec betterdesk-console bash

# Restart entire stack
docker compose restart

# Check database status
docker compose exec betterdesk-console sqlite3 /opt/rustdesk/db_v2.sqlite3 ".tables"

# Check users in database
docker compose exec betterdesk-console sqlite3 /opt/rustdesk/db_v2.sqlite3 "SELECT username, role FROM users;"
```

## 🔒 Security & Updates

### ⚠️ Watchtower Removed

**Important**: Watchtower has been removed from docker-compose.yml as it's **no longer maintained** and poses a security risk.

### ✅ Safe Update Methods

```bash
# Method 1: Manual updates (recommended)
docker-compose pull && docker-compose down && docker-compose up -d

# Method 2: Update specific services
docker-compose pull betterdesk-console
docker-compose up -d betterdesk-console

# Method 3: Check for updates first
docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}"
```

### 🤖 Automated Alternatives

Instead of Watchtower, consider modern secure alternatives:

1. **GitHub Dependabot** - Automatic dependency updates via PR
2. **Renovate Bot** - Advanced dependency management 
3. **Custom scripts** with notifications
4. **Kubernetes operators** (for K8s environments)

### 📅 Update Schedule

```bash
# Weekly security check (add to cron)
#!/bin/bash
cd /path/to/BetterDesk-Console
docker-compose pull --quiet
if [ $? -eq 0 ]; then
    echo "Updates available - review and apply manually"
    docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}"
fi
```

---

**⚠️ IMPORTANT**: After first login, always change the default administrator password in the console settings!

---

## Problem: Shell Not Available in HBBS/HBBR Containers

### Symptom
When trying to exec into the hbbs or hbbr containers, you get errors like:
```
OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH
```

### Cause
The official `rustdesk/rustdesk-server:latest` image is based on `FROM scratch` which contains only the binaries without any shell or utilities.

### Solution
BetterDesk Console now uses custom Dockerfiles (`Dockerfile.hbbs` and `Dockerfile.hbbr`) that:
1. Copy binaries from the official RustDesk image
2. Use `busybox:musl` as base for shell support
3. Provide essential tools: `sh`, `nc`, `wget`, `cat`, `ls`, `echo`, etc.

If you're upgrading from an older version, rebuild the images:
```bash
docker-compose build --no-cache hbbs hbbr
docker-compose up -d
```