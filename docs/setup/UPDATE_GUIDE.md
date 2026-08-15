# Legacy BetterDesk v1 Update Scripts

This document is retained for historical migrations from the v1.0.0/v1.1.0
Flask-era console. The scripts and SSH workflow described below are not the
supported update path for current BetterDesk releases.

## Current supported update paths

- Native Linux: `sudo ./betterdesk.sh` → Update, or
  `sudo ./betterdesk.sh --auto` for a scripted update.
- Native Windows: run `.\betterdesk.ps1` as Administrator and choose Update,
  or `.\betterdesk.ps1 -Auto`.
- Docker: `docker compose pull && docker compose up -d` for image deployments,
  or use `betterdesk-docker.sh` for a source rebuild.
- Panel/CLI: Settings → Updates or `node web-nodejs/scripts/update-cli.js`.

See [`docs/important/installer-contract.md`](../important/installer-contract.md)
and [`docs/important/betterdesk-update-flow.md`](../important/betterdesk-update-flow.md)
for current backup, rollback, SHA and health-check guarantees.

The remainder of this file documents the legacy migration only.

## What's New in v1.1.0

- **Soft Delete System** (v1.0.1): Devices are marked as deleted instead of permanently removed
- **Device Banning System** (v1.1.0): Complete ban management with reason tracking
- **Ban Enforcer**: Active connection blocking for banned devices (optional but recommended)
- **Enhanced UI**: Ban/Unban buttons, visual indicators, banned statistics
- **Security**: Input validation, XSS protection, SQL injection prevention

## ⚠️ Important: Ban Enforcer

**RustDesk Server OSS doesn't check the `is_banned` column by default!**

Without Ban Enforcer:
- ✅ Devices show as "banned" in web UI
- ❌ Devices can still connect to RustDesk server

With Ban Enforcer:
- ✅ Devices show as "banned" in web UI
- ✅ Devices are actively blocked from connecting

**Ban Enforcer is automatically offered during update.** See [BAN_ENFORCER.md](BAN_ENFORCER.md) for details.

## Prerequisites

### Linux (update.sh)
- Existing BetterDesk Console installation
- Root/sudo access
- Python 3.x installed
- SQLite3 database at `/opt/rustdesk/db_v2.sqlite3`

### Windows (update.ps1)
- PowerShell 5.1 or higher
- SSH client (OpenSSH or similar)
- SSH key-based authentication configured
- Access to remote Linux server running BetterDesk

## Usage

### Linux (Direct Installation)

```bash
# Make script executable
chmod +x update.sh

# Run with sudo (default paths)
sudo ./update.sh

# Custom RustDesk directory
sudo ./update.sh --rustdesk-dir /custom/path/rustdesk

# Custom console directory
sudo ./update.sh --console-dir /var/www/betterdesk

# Custom both directories
sudo ./update.sh --rustdesk-dir /custom/rustdesk --console-dir /custom/console

# Show help
./update.sh --help
```

**Default paths:**
- RustDesk: `/opt/rustdesk`
- Console: `/opt/BetterDeskConsole`
- Database: `{rustdesk-dir}/db_v2.sqlite3`

**What it does:**
1. Checks for existing installation
2. Creates backup of database and files
3. Executes database migrations
4. Updates web console files
5. Restarts BetterDesk service
6. Verifies installation

### Windows (Remote Update via SSH)

```powershell
# Basic usage
.\update.ps1 -RemoteHost YOUR_SERVER_IP -RemoteUser YOUR_SSH_USER

# With custom RustDesk path
.\update.ps1 -RemoteHost YOUR_SERVER_IP -RemoteUser YOUR_SSH_USER -RustDeskPath "/custom/path/rustdesk"

# With custom console path
.\update.ps1 -RemoteHost YOUR_SERVER_IP -RemoteUser YOUR_SSH_USER -RemotePath "/var/www/betterdesk"

# With custom database path (overrides auto-detection)
.\update.ps1 -RemoteHost YOUR_SERVER_IP -RemoteUser YOUR_SSH_USER -DbPath "/custom/db/path.sqlite3"

# All custom paths
.\update.ps1 -RemoteHost YOUR_SERVER_IP -RemoteUser YOUR_SSH_USER -RemotePath "/var/www/betterdesk" -RustDeskPath "/custom/rustdesk"
```

**Parameters:**
- `-RemoteHost` (required): Server hostname or IP
- `-RemoteUser` (required): SSH username
- `-RemotePath`: Console directory (default: `/opt/BetterDeskConsole`)
- `-RustDeskPath`: RustDesk directory (default: `/opt/rustdesk`)
- `-DbPath`: Database path (default: auto-set to `{RustDeskPath}/db_v2.sqlite3`)

**What it does:**
1. Validates local files
2. Tests SSH connection
3. Creates remote backup
4. Uploads migration scripts
5. Executes migrations remotely
6. Updates web files via SCP
7. Restarts service
8. Verifies installation

## Migration Details

### v1.0.1 - Soft Delete System
Adds to `peer` table:
- `is_deleted` (INTEGER, default 0)
- `deleted_at` (INTEGER, timestamp)
- `updated_at` (INTEGER, timestamp)
- Index on `is_deleted`

### v1.1.0 - Device Banning System
Adds to `peer` table:
- `is_banned` (INTEGER, default 0)
- `banned_at` (INTEGER, timestamp)
- `banned_by` (VARCHAR(100), administrator)
- `ban_reason` (TEXT, reason for ban)
- Index on `is_banned`

## Backup & Rollback

### Automatic Backup
Both scripts create automatic backups:
- **Location**: `/opt/betterdesk-backup-YYYYMMDD-HHMMSS/`
- **Contents**: Database, app.py, script.js, index.html

### Manual Rollback

```bash
# 1. Stop service
sudo systemctl stop betterdesk

# 2. Restore database
sudo cp /opt/betterdesk-backup-YYYYMMDD-HHMMSS/db_v2.sqlite3.backup /opt/rustdesk/db_v2.sqlite3

# 3. Restore web files
sudo cp /opt/betterdesk-backup-YYYYMMDD-HHMMSS/app.py.backup /opt/BetterDeskConsole/app.py
sudo cp /opt/betterdesk-backup-YYYYMMDD-HHMMSS/script.js.backup /opt/BetterDeskConsole/static/script.js
sudo cp /opt/betterdesk-backup-YYYYMMDD-HHMMSS/index.html.backup /opt/BetterDeskConsole/templates/index.html

# 4. Start service
sudo systemctl start betterdesk
```

## Troubleshooting

### Linux Script Issues

**Permission denied:**
```bash
chmod +x update.sh
sudo ./update.sh
```

**Service not found:**
- Script will skip service restart
- Manually restart: `sudo systemctl restart betterdesk`

**Migration fails:**
- Check database permissions: `ls -l /opt/rustdesk/db_v2.sqlite3`
- Run with sudo: `sudo python3 migrations/v1.1.0_device_bans.py`

### Windows Script Issues

**SSH connection failed:**
```powershell
# Test SSH manually
ssh YOUR_SSH_USER@YOUR_SERVER_IP

# Set up SSH keys
ssh-copy-id YOUR_SSH_USER@YOUR_SERVER_IP
```

**SCP upload fails:**
```powershell
# Check SSH access
ssh YOUR_SSH_USER@YOUR_SERVER_IP "ls -la /opt/BetterDeskConsole"

# Verify file permissions
ssh YOUR_SSH_USER@YOUR_SERVER_IP "whoami; groups"
```

**Execution policy error:**
```powershell
# Allow script execution
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# Or run with bypass
powershell -ExecutionPolicy Bypass -File update.ps1 -RemoteHost YOUR_SERVER_IP -RemoteUser YOUR_SSH_USER
```

## Verification

After update, verify installation:

```bash
# Check database schema (should show 16+ columns)
sqlite3 /opt/rustdesk/db_v2.sqlite3 "PRAGMA table_info(peer);" | wc -l

# Check service status
systemctl status betterdesk

# Test web console
curl http://localhost:5000/api/stats
```

Expected output:
```json
{
  "success": true,
  "stats": {
    "total": 51,
    "active": 14,
    "inactive": 37,
    "banned": 0,
    "with_notes": 21
  }
}
```

## Manual Update (Without Scripts)

If scripts fail, you can update manually:

```bash
# 1. Backup
sudo cp /opt/rustdesk/db_v2.sqlite3 /tmp/db_backup.sqlite3

# 2. Run migrations
sudo python3 migrations/v1.0.1_soft_delete.py
sudo python3 migrations/v1.1.0_device_bans.py

# 3. Copy files
sudo cp web/app.py /opt/BetterDeskConsole/
sudo cp web/static/script.js /opt/BetterDeskConsole/static/
sudo cp web/templates/index.html /opt/BetterDeskConsole/templates/

# 4. Restart
sudo systemctl restart betterdesk
```

## Support

For issues or questions:
- Check [CHANGELOG.md](CHANGELOG.md) for detailed changes
- Review [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) for future plans
- Check server logs: `journalctl -u betterdesk -f`

## License

MIT License - See [LICENSE](LICENSE) file for details
