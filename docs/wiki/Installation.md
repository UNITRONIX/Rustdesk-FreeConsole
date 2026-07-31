# Installation

BetterDesk supports **Linux (bare-metal)**, **Windows (PowerShell)**, and **Docker** as primary install paths. **FreeBSD** is Tier 3 / community (manual build + example `rc.d`; no `betterdesk.sh`). Default Linux paths are `/opt/betterdesk` (Go server) and `/opt/BetterDeskConsole` (web panel); the installer still detects legacy `/opt/rustdesk` installs.

---

## Requirements

### Linux
- Ubuntu 20.04+ / Debian 11+ / CentOS 8+ / AlmaLinux 8+
- 1 CPU core, 512 MB RAM minimum (2 cores, 2 GB recommended)
- Root access (sudo)
- Open ports: 21114-21119 TCP, 21116 UDP, 5000 TCP (web console)
- Node.js 18+ (auto-installed by script)

### Windows
- Windows 10/11 or Windows Server 2019+
- PowerShell 5.1+ (run as Administrator)
- [NSSM](https://nssm.cc/) (auto-installed by script)
- Open firewall ports: 21114-21119 TCP, 21116 UDP, 5000 TCP

### Docker
- Docker Engine 20.10+ with Docker Compose v2
- 512 MB RAM minimum

### FreeBSD (experimental / community)
- FreeBSD 13+ (amd64); root or doas/sudo
- `pkg` packages: `git`, `go`, `node`, `npm`, `python3`, `ca_root_nss`
- Open ports (e.g. via `pf`): TCP 21114-21119, 21121, 5000; UDP 21116
- No official installer or release binaries — see [FreeBSD (experimental)](#freebsd-experimental) below and `contrib/freebsd/`

---

## Linux Installation

### Interactive Mode

```bash
git clone https://github.com/UNITRONIX/BetterDesk.git
cd BetterDesk
sudo ./betterdesk.sh
```

The interactive menu offers:

| Option | Description |
|--------|-------------|
| **1** | New installation (full setup from scratch) |
| **2** | Update existing installation |
| **3** | Repair (auto-fix common issues) |
| **4** | Validate installation correctness |
| **5** | Create backup |
| **6** | Reset admin password |
| **7** | Build binaries from source |
| **8** | Run diagnostics |
| **9** | Uninstall |
| **C** | Configure SSL/TLS certificates |
| **M** | Migrate databases (SQLite ↔ PostgreSQL) |

### Automatic Mode

```bash
sudo ./betterdesk.sh --auto
```

Non-interactive install with default settings. Useful for CI/CD or scripted deployments.

### Options

```bash
# Skip SHA256 binary verification
sudo ./betterdesk.sh --skip-verify

# Custom API port
API_PORT=21120 sudo ./betterdesk.sh --auto

# Custom relay servers (overrides auto-detected IP)
RELAY_SERVERS=YOUR.PUBLIC.IP sudo ./betterdesk.sh --auto
```

### Installation Path

After installation, files are located at:

| Path | Description |
|------|-------------|
| `/opt/betterdesk/` | Go server binary, keys, database |
| `/opt/BetterDeskConsole/` | Node.js web console |
| `/etc/systemd/system/betterdesk-server.service` | Go server systemd service |
| `/etc/systemd/system/betterdesk-console.service` | Node.js systemd service |

### Verify Installation

```bash
sudo systemctl status betterdesk-server
sudo systemctl status betterdesk-console

# Check logs
journalctl -u betterdesk-server -f
journalctl -u betterdesk-console -f
```

---

## Windows Installation

### Interactive Mode

Open PowerShell **as Administrator**:

```powershell
git clone https://github.com/UNITRONIX/BetterDesk.git
cd BetterDesk
.\betterdesk.ps1
```

### Automatic Mode

```powershell
.\betterdesk.ps1 -Auto
```

### Options

```powershell
# Skip SHA256 verification
.\betterdesk.ps1 -SkipVerify

# Custom API port
$env:API_PORT = "21114"
.\betterdesk.ps1 -Auto
```

### Installation Path

| Path | Description |
|------|-------------|
| `C:\BetterDesk\` | Go server binary, keys, database |
| `C:\BetterDeskConsole\` | Node.js web console |

Services are registered via NSSM and can be managed from `services.msc`.

---

## Docker Installation

### Quick Start (Pre-built Images)

```bash
curl -fsSL https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/docker-compose.quick.yml -o docker-compose.yml
docker compose up -d
```

### Build Locally

```bash
git clone https://github.com/UNITRONIX/BetterDesk.git
cd BetterDesk
docker compose up -d --build
```

### Interactive Docker Script

```bash
./betterdesk-docker.sh
```

See [[Docker]] for detailed Docker documentation.

---

## FreeBSD (experimental)

FreeBSD is **Tier 3 (community)**. There is no `betterdesk.sh` path (that installer assumes Linux + systemd). Build the Go server and Node panel from source, then optionally install the example `rc.d` scripts from the repository.

### Quick outline

```sh
pkg install -y git go node npm python3 ca_root_nss

git clone https://github.com/UNITRONIX/BetterDesk.git
cd BetterDesk/betterdesk-server
CGO_ENABLED=0 go build -o betterdesk-server .
install -d /usr/local/betterdesk
install -m 755 betterdesk-server /usr/local/betterdesk/
# Place id_ed25519 / id_ed25519.pub under /usr/local/betterdesk

# Panel: copy web-nodejs → /usr/local/BetterDeskConsole, then:
cd /usr/local/BetterDeskConsole
npm ci --omit=dev
# Configure .env (RUSTDESK_DIR=/usr/local/betterdesk, etc.)

install -m 755 /path/to/BetterDesk/contrib/freebsd/rc.d/betterdesk_server \
  /usr/local/etc/rc.d/betterdesk_server
install -m 755 /path/to/BetterDesk/contrib/freebsd/rc.d/betterdesk_console \
  /usr/local/etc/rc.d/betterdesk_console

sysrc betterdesk_server_enable=YES
sysrc betterdesk_server_relay=YOUR.PUBLIC.IP
sysrc betterdesk_console_enable=YES
service betterdesk_server start
service betterdesk_console start
```

Full notes, path defaults, and limits (no panel updater FreeBSD binaries): see [`contrib/freebsd/README.md`](../../contrib/freebsd/README.md) in the repo. Pull requests improving FreeBSD packaging are welcome ([#310](https://github.com/UNITRONIX/BetterDesk/issues/310)).

---

## PostgreSQL Setup

By default, BetterDesk uses SQLite. To use PostgreSQL:

### During Installation

When prompted for database type, choose **PostgreSQL** and provide the connection DSN:

```
postgres://user:password@host:5432/betterdesk?sslmode=disable
```

### Migrate Existing Data

```bash
# Interactive
sudo ./betterdesk.sh
# Choose option M — Migrate databases

# Or use the migration tool directly
./tools/migrate/migrate-linux-amd64 -mode sqlite2pg \
  -src /opt/betterdesk/db_v2.sqlite3 \
  -dst "postgres://user:pass@localhost:5432/betterdesk"
```

See [[Migration]] for more details.

---

## After Installation

1. Open **http://your-server:5000** in a browser
2. Log in with the admin credentials displayed during installation
3. Configure your [[Client Setup|RustDesk clients]] to connect to your server
4. Optionally configure [[TLS/SSL certificates|TLS-SSL]] for encrypted connections

---

## Upgrading

### From Previous BetterDesk Version

```bash
# Linux
sudo ./betterdesk.sh
# Choose option 2 — Update

# Windows
.\betterdesk.ps1
# Choose option 2 — Update
```

The update process preserves:
- Database files (auth.db, db_v2.sqlite3)
- PostgreSQL configuration
- SSL certificates
- API keys
- Admin credentials

### From RustDesk OSS Server

If you are migrating from the original RustDesk OSS server (`hbbs`+`hbbr`), the installer detects the legacy Rust server and recommends a fresh install. See [[Migration]] for data migration steps.

---

## Uninstalling

```bash
# Linux
sudo ./betterdesk.sh
# Choose option 9 — Uninstall

# Windows
.\betterdesk.ps1
# Choose option 9 — Uninstall
```

This removes all services, binaries, and optionally data files.

---

## See also

- [[Configuration]] — environment variables and service units
- [[Panel Updates|Panel-Updates]] — in-app updates via Settings → Updates
- [[Docker Deployment|Docker]] — container deployment
- [[Migration Guide|Migration]] — SQLite ↔ PostgreSQL, RustDesk OSS migration
