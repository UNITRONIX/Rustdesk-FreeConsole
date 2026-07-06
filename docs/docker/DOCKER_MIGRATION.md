# 🔄 Docker Migration Guide

Migrate your existing RustDesk Docker installation to BetterDesk Console with zero downtime for client devices.

---

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Automatic Migration (Recommended)](#automatic-migration-recommended)
- [Manual Migration](#manual-migration)
- [What Gets Migrated](#what-gets-migrated)
- [Post-Migration Checklist](#post-migration-checklist)
- [Rollback](#rollback)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

---

## Overview

BetterDesk Console is fully compatible with existing RustDesk server installations. The migration process preserves your encryption keys, device database, and client connections. **Existing RustDesk clients will continue to work without any changes** after migration.

### What changes

| Component | Before (RustDesk) | After (BetterDesk) |
|---|---|---|
| Signal server (hbbs) | `rustdesk/rustdesk-server` | `betterdesk-hbbs:local` |
| Relay server (hbbr) | `rustdesk/rustdesk-server` | `betterdesk-hbbr:local` |
| Web console | ❌ None | ✅ `betterdesk-console:local` |
| Encryption keys | Preserved ✅ | Same keys ✅ |
| Device database | `db_v2.sqlite3` | Same file ✅ |
| Ports | 21115-21117 | Same ports ✅ |

---

## Prerequisites

- Docker and Docker Compose installed
- Access to existing RustDesk data directory
- BetterDesk repository cloned:
  ```bash
  git clone https://github.com/UNITRONIX/Rustdesk-FreeConsole.git
  cd Rustdesk-FreeConsole
  ```

---

## Automatic Migration (Recommended)

The `betterdesk-docker.sh` script includes interactive migration (option **M**):

```bash
chmod +x betterdesk-docker.sh
./betterdesk-docker.sh
# Select: M (Migrate from existing RustDesk)
```

The wizard will:
1. Scan for existing RustDesk containers and data
2. Show a summary of what was found
3. Create a backup of your existing data
4. Stop old RustDesk containers
5. Copy encryption keys and database to BetterDesk data directory
6. Build and start BetterDesk containers
7. Create a web admin account

> **Note:** Your original data is never deleted. Old containers are stopped but not removed.

---

## Manual Migration

If you prefer to migrate manually, follow these steps.

### Step 1: Identify your current setup

Find your existing RustDesk containers:

```bash
docker ps -a | grep -E "hbbs|hbbr|rustdesk"
```

Find the data directory (bind mount):

```bash
docker inspect <container_name> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

Typical data locations:
- `./data` (relative to compose file)
- `/opt/rustdesk`
- `$HOME/rustdesk`

### Step 2: Verify critical files

Your data directory should contain:

```bash
ls -la /path/to/your/data/
# Expected files:
#   id_ed25519       ← Encryption private key (CRITICAL)
#   id_ed25519.pub   ← Public key
#   db_v2.sqlite3    ← Device database
```

> **⚠️ IMPORTANT:** The `id_ed25519` key is essential. Without it, all existing clients will need to be reconfigured with a new key.

### Step 3: Create a backup

```bash
mkdir -p /opt/betterdesk-backups
cp -r /path/to/your/data /opt/betterdesk-backups/pre_migration_$(date +%Y%m%d)
```

### Step 4: Stop existing containers

```bash
# If using docker-compose:
cd /path/to/your/rustdesk/compose
docker compose down

# Or stop containers individually:
docker stop <hbbs_container> <hbbr_container>
```

### Step 5: Copy data to BetterDesk directory

```bash
# Create BetterDesk data directory
mkdir -p /opt/betterdesk-data

# Copy critical files
cp /path/to/your/data/id_ed25519 /opt/betterdesk-data/
cp /path/to/your/data/id_ed25519.pub /opt/betterdesk-data/
cp /path/to/your/data/db_v2.sqlite3 /opt/betterdesk-data/
```

### Step 6: Build and start BetterDesk

```bash
cd Rustdesk-FreeConsole

# Set data directory (if not using default /opt/betterdesk-data)
export DATA_DIR=/opt/betterdesk-data

# Build images (required - images are NOT on Docker Hub)
docker compose build

# Start containers
docker compose up -d
```

### Step 7: Verify

```bash
# Check containers are running
docker ps | grep betterdesk

# Check logs
docker logs betterdesk-hbbs --tail 20
docker logs betterdesk-console --tail 20

# Access web panel
echo "Open http://$(curl -s ifconfig.me):5000 in your browser"
```

---

## What Gets Migrated

| File | Description | Required |
|---|---|---|
| `id_ed25519` | Private encryption key | **Critical** - clients use this to connect |
| `id_ed25519.pub` | Public key | Important - can be regenerated from private key |
| `db_v2.sqlite3` | Device database (peers, groups, etc.) | Important - contains device registry |
| `.api_key` | API authentication key | Optional - new one will be generated |

### Data NOT migrated automatically

- Custom `docker-compose.yml` settings (port changes, custom networks)
- Environment variables from your old setup
- External reverse proxy configurations

---

## Post-Migration Checklist

- [ ] Web panel accessible at `http://YOUR_IP:5000`
- [ ] Admin login works with the generated credentials
- [ ] Existing devices appear in the device list
- [ ] New client connections work (test with RustDesk client)
- [ ] Relay connections work (port 21117)
- [ ] Old containers are stopped (verify with `docker ps -a`)

---

## Rollback

If something goes wrong, you can restore your original setup:

```bash
# 1. Stop BetterDesk containers
cd Rustdesk-FreeConsole
docker compose down

# 2. Restore your original data
cp -r /opt/betterdesk-backups/pre_migration_*/* /path/to/your/data/

# 3. Start your original containers
cd /path/to/your/rustdesk/compose
docker compose up -d
```

---

## Troubleshooting

### Clients show as offline after migration

**Cause:** Encryption key mismatch.

**Solution:** Verify that `id_ed25519` in BetterDesk data directory is identical to the original:
```bash
md5sum /opt/betterdesk-data/id_ed25519
md5sum /path/to/original/data/id_ed25519
# Both should match
```

### Port conflicts

**Cause:** Old containers still using the same ports.

**Solution:** Stop and remove old containers:
```bash
docker stop <old_hbbs> <old_hbbr>
docker rm <old_hbbs> <old_hbbr>
```

### "No such table: peer" error

**Cause:** Database was not copied or is corrupted.

**Solution:** Copy the database file again:
```bash
cp /opt/betterdesk-backups/pre_migration_*/db_v2.sqlite3 /opt/betterdesk-data/
docker restart betterdesk-hbbs
```

### Web console shows 0 devices

**Cause:** Database path mismatch in compose file.

**Solution:** Ensure `DATABASE_PATH` environment variable in `docker-compose.yml` points to the correct file:
```yaml
environment:
  - DATABASE_PATH=/opt/rustdesk/db_v2.sqlite3
```

---

## Migrate split Docker → single container (official image)

If you already run the legacy **two-container** quick-start (`betterdesk-server` + `betterdesk-console`), you can switch to the official **all-in-one** image without losing data. Named volumes (`betterdesk-data`, `betterdesk-console-data`) are reused.

```bash
cd /opt/betterdesk/docker   # or your compose directory
docker compose down

curl -fsSL https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/docker-compose.quick.single.yml -o docker-compose.yml

# Keep BETTERDESK_IMAGE_TAG / RELAY_SERVERS from your existing .env
docker compose --env-file .env pull
docker compose --env-file .env up -d

docker compose exec betterdesk betterdesk-show-admin-credentials
```

**Client change:** if you configured the RustDesk API server, update from port `21114` to `21121` (`http://YOUR_HOST:21121`).

To stay on split images, use `install.sh --split` or keep `docker-compose.quick.yml`.

---

## FAQ

**Q: Will my existing clients need to be reconfigured?**
A: No. As long as the encryption key (`id_ed25519`) is preserved, all clients continue to work seamlessly.

**Q: Can I run both the old and new setup simultaneously?**
A: Not on the same machine (port conflicts). You can run them on different machines with the same key for testing.

**Q: What if I used Docker volumes instead of bind mounts?**
A: You'll need to copy data from the volume first:
```bash
docker cp <old_hbbs_container>:/root/id_ed25519 /opt/betterdesk-data/
docker cp <old_hbbs_container>:/root/id_ed25519.pub /opt/betterdesk-data/
docker cp <old_hbbs_container>:/root/db_v2.sqlite3 /opt/betterdesk-data/
```

**Q: Does migration support RustDesk Server Pro?**
A: No. BetterDesk is designed for the open-source RustDesk server only.

**Q: Is it possible to migrate from a non-Docker RustDesk installation?**
A: Yes! Use `betterdesk.sh` (Linux) or `betterdesk.ps1` (Windows) instead — they handle migration from native RustDesk installations automatically.

---

*Last updated: 2026-07-06*
