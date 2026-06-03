# 🔧 Bug Fixes - User-Reported Issues

## 🐛 Reported Problems

### Problem 1: Docker Error
```bash
sh: 1: executable file not found in $PATH
```

**Cause:**  
The Docker image `python:3.11-slim` by default does not include `bash`, and `docker-entrypoint.sh` has a shebang `#!/bin/bash`.

**Impact:**
- Docker containers won't start
- Error occurs during `docker-compose up`
- Application doesn't work in Docker

---

### Problem 2: PowerShell Error
```powershell
Write-Info : The term 'Write-Info' is not recognized as the name of a cmdlet
```

**Cause:**  
Custom functions `Write-Error`, `Write-Warning`, and `Write-Info` in `install-improved.ps1` conflict with PowerShell built-in cmdlets.

**Impact:**
- PowerShell installation script doesn't work
- Error when running `.\install-improved.ps1`
- Installation fails

---

## ✅ Solutions

### Fix 1: Docker - Add bash

**Modified file:** `Dockerfile.console`

**Before:**
```dockerfile
RUN apt-get update && apt-get install -y \
    gcc \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*
```

**After:**
```dockerfile
RUN apt-get update && apt-get install -y \
    bash \
    gcc \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*
```

**What changed:**
- Added `bash` to the list of installed packages
- Ensures that `#!/bin/bash` works in `docker-entrypoint.sh`

---

### Fix 2: PowerShell - Rename Functions

**Modified file:** `install-improved.ps1`

**Before:**
```powershell
function Write-Error {
    param([string]$Message)
    Write-Host "❌ ERROR: $Message" -ForegroundColor Red
}

function Write-Warning {
    param([string]$Message)
    Write-Host "⚠️ WARNING: $Message" -ForegroundColor Yellow
}

function Write-Info {
    param([string]$Message)
    Write-Host "ℹ️ INFO: $Message" -ForegroundColor Cyan
}
```

**After:**
```powershell
function Write-ErrorMsg {
    param([string]$Message)
    Write-Host "❌ ERROR: $Message" -ForegroundColor Red
}

function Write-WarningMsg {
    param([string]$Message)
    Write-Host "⚠️ WARNING: $Message" -ForegroundColor Yellow
}

function Write-InfoMsg {
    param([string]$Message)
    Write-Host "ℹ️ INFO: $Message" -ForegroundColor Cyan
}
```

**What changed:**
- Renamed `Write-Error` → `Write-ErrorMsg`
- Renamed `Write-Warning` → `Write-WarningMsg`
- Renamed `Write-Info` → `Write-InfoMsg`
- Updated **58 function calls** throughout the file

**Additional changes:**
```powershell
# Added at the beginning of the file
#Requires -Version 5.1
Set-StrictMode -Version Latest
```

---

## 🧪 Testing

### Test 1: Docker

```bash
# Rebuild the image
docker-compose down
docker-compose build --no-cache

# Start containers
docker-compose up -d

# Check logs
docker logs rustdesk-console

# Expected result:
✅ "Starting RustDesk Console..."
✅ "Database initialized"
✅ No errors about "bash not found"
```

### Test 2: PowerShell

```powershell
# Run the script
.\install-improved.ps1

# Expected result:
✅ No errors about "Write-Info"
✅ Script executes normally
✅ Messages display with emojis and colors
```

---

## 📝 Changed Files

### 1. Dockerfile.console
**Lines changed:** 1  
**Location:** Line ~15 (RUN apt-get install)  
**Impact:** Docker image now includes bash

### 2. install-improved.ps1
**Lines changed:** ~60  
**Location:** 
- Lines 28-46: Function definitions (3 functions)
- Lines 50-500: Function calls (58 calls)  
**Impact:** PowerShell script now works without conflicts

---

## 🔍 Diagnostics

### Check if Docker Fix Works:

```bash
docker exec -it rustdesk-console bash --version
# Expected output: GNU bash, version 5.x.x
```

### Check if PowerShell Fix Works:

```powershell
# In PowerShell:
Get-Command Write-ErrorMsg
# Expected output: CommandType: Function, Name: Write-ErrorMsg

Get-Command Write-Info
# Expected output: CommandType: Cmdlet (built-in, not ours)
```

---

## 🎯 Summary

| Problem | Cause | Solution | Status |
|---------|-------|----------|--------|
| Docker bash error | Missing bash in image | Added bash to Dockerfile | ✅ Fixed |
| PowerShell Write-Info | Function name conflict | Renamed to Write-InfoMsg | ✅ Fixed |

**All problems resolved and tested.**

---

## 📚 Additional Information

### Why bash wasn't included?

`python:3.11-slim` is a minimal image to reduce size. It includes only:
- Python 3.11
- Essential libraries
- sh (minimal shell)

Bash must be installed manually.

### Why function name conflict?

PowerShell has built-in cmdlets:
- `Write-Error` - writes errors to error stream
- `Write-Warning` - writes warnings
- `Write-Host` - writes to console
- `Write-Verbose`, `Write-Debug` etc.

Custom functions with these names override built-in cmdlets, which can cause problems.

**Best practice:**  
Always use unique function names, e.g., `Write-CustomError` or `Write-ErrorMsg`.

---

## ✅ Checklist

- [x] Docker: Added bash to Dockerfile.console
- [x] Docker: Tested building the image
- [x] Docker: Tested starting containers
- [x] PowerShell: Renamed Write-Error → Write-ErrorMsg
- [x] PowerShell: Renamed Write-Warning → Write-WarningMsg
- [x] PowerShell: Renamed Write-Info → Write-InfoMsg
- [x] PowerShell: Updated 58 function calls
- [x] PowerShell: Added #Requires -Version 5.1
- [x] PowerShell: Added Set-StrictMode
- [x] Documentation: Created TROUBLESHOOTING.md
- [x] Documentation: Created QUICK_FIX.md

---

**Last Updated:** February 4, 2026  

Thank you for reporting the problems! 🙏

---

## 🔴 Problem 3: All Devices Show as "Offline"

### Symptoms
- All devices in BetterDesk Console are shown as "Offline"
- RustDesk clients can connect to each other normally
- `status` column in database is always 0 or NULL

### Cause
You are using the **original RustDesk hbbs binary** instead of the **BetterDesk enhanced binary**.

The original hbbs does NOT update the `status` field in the database - this is a BetterDesk-specific feature.

### How to Check

Run this command to see which binary you have:
```bash
/opt/rustdesk/hbbs --help | head -5
```

**BetterDesk binary shows:**
```
hbbs 1.1.14
Purslane Ltd. <info@rustdesk.com>
BetterDesk Enhanced Server v2.0.0
```

**Original binary shows:**
```
hbbs 1.1.14
Purslane Ltd. <info@rustdesk.com>
RustDesk ID/Rendezvous Server
```

### Solution

#### Option 1: Use Diagnostic Script (Recommended)
```bash
cd /path/to/Rustdesk-FreeConsole
chmod +x dev_modules/diagnose_offline_status.sh
./dev_modules/diagnose_offline_status.sh
```

#### Option 2: Manual Fix

1. **Stop current hbbs:**
```bash
sudo pkill -f hbbs
```

2. **Backup original binary:**
```bash
sudo cp /opt/rustdesk/hbbs /opt/rustdesk/hbbs.backup-original
```

3. **Install BetterDesk binary:**
```bash
# Download if you don't have it
git clone https://github.com/UNITRONIX/Rustdesk-FreeConsole.git
cd Rustdesk-FreeConsole

# Copy enhanced binary
sudo cp hbbs-patch-v2/hbbs-linux-x86_64 /opt/rustdesk/hbbs
sudo cp hbbs-patch-v2/hbbr-linux-x86_64 /opt/rustdesk/hbbr
sudo chmod +x /opt/rustdesk/hbbs /opt/rustdesk/hbbr
```

4. **Start with API port:**
```bash
cd /opt/rustdesk
sudo ./hbbs -k _ --api-port 21114 &
sudo ./hbbr &
```

5. **Verify:**
```bash
/opt/rustdesk/hbbs --help | grep -i betterdesk
# Should show: BetterDesk Enhanced Server v2.0.0
```

### For Manual (non-systemd) Installations

If you're NOT using systemd services, you need to:

1. **Create a startup script** (`/opt/rustdesk/start.sh`):
```bash
#!/bin/bash
cd /opt/rustdesk
./hbbs -k _ --api-port 21114 > hbbs.log 2>&1 &
./hbbr > hbbr.log 2>&1 &
echo "RustDesk servers started"
```

2. **Or create systemd services** (recommended):
```bash
# Signal server service
sudo tee /etc/systemd/system/rustdesksignal.service << 'EOF'
[Unit]
Description=RustDesk Signal Server (BetterDesk)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/rustdesk
ExecStart=/opt/rustdesk/hbbs -k _ --api-port 21114
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Relay server service
sudo tee /etc/systemd/system/rustdeskrelay.service << 'EOF'
[Unit]
Description=RustDesk Relay Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/rustdesk
ExecStart=/opt/rustdesk/hbbr
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable rustdesksignal rustdeskrelay
sudo systemctl start rustdesksignal rustdeskrelay
```

### Understanding How Online Status Works

```
┌─────────────┐     register      ┌──────────────┐     updates      ┌──────────────┐
│  RustDesk   │ ───────────────► │  BetterDesk  │ ───────────────► │   SQLite     │
│   Client    │                  │    hbbs      │   status=1       │  db_v2.sqlite│
└─────────────┘                  └──────────────┘   last_online    └──────────────┘
                                                                           │
                                                                           │ reads
                                                                           ▼
                                 ┌──────────────┐                   ┌──────────────┐
                                 │  BetterDesk  │ ◄──────────────── │   Web UI     │
                                 │   Console    │    status=1?     │   Browser    │
                                 └──────────────┘    → Online       └──────────────┘
```

**Key point:** Only the **BetterDesk enhanced hbbs** updates the database with online status. The original RustDesk hbbs does not have this feature.

---

## Problem 3: Relay Connection Failed (IPv6)

### Symptoms

RustDesk clients display:
```
Relay connection failed: Connection to relay server failed. Please try again later.
```
(German: "Verbindungsfehler — Verbindung über Relay-Server ist fehlgeschlagen")

This happens across **all** client platforms (Windows, Linux, macOS, Android). No errors appear in BetterDesk server or console logs.

### Root Cause

The server resolved an **IPv6-only** address for `RELAY_SERVERS`. Many RustDesk clients cannot connect to a relay via pure IPv6, especially on networks without proper IPv6 support.

### How to Check

```bash
# Linux: check the systemd service for relay-servers parameter
sudo systemctl cat betterdesk-server | grep relay-servers

# If you see something like:
#   -relay-servers 2a01:4f8:xxxx::1
# That's the problem — it's IPv6-only.
```

```powershell
# Windows: check the scheduled task or NSSM service arguments
nssm get BetterDeskServer AppParameters
# Or check the task in Task Scheduler → BetterDesk → BetterDeskServer → Arguments
```

### Solution

Change `RELAY_SERVERS` to use an **IPv4 address** (or both IPv4 and IPv6):

**Linux:**
```bash
# Edit the service file
sudo nano /etc/systemd/system/betterdesk-server.service

# Change -relay-servers from IPv6 to IPv4:
# Before: -relay-servers 2a01:4f8:xxxx::1
# After:  -relay-servers 203.0.113.10

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart betterdesk-server
```

**Windows:**
```powershell
# Update NSSM service parameters
nssm set BetterDeskServer AppParameters "-mode all -relay-servers YOUR_IPV4_ADDRESS ..."
Restart-Service BetterDeskServer

# Or edit the scheduled task arguments in Task Scheduler
```

**Docker:**
```yaml
# docker-compose.yml
services:
  betterdesk-server:
    command: >-
      -mode all
      -relay-servers YOUR_IPV4_ADDRESS
      ...
```

### Prevention

As of v2.4.0, the ALL-IN-ONE installation scripts (`betterdesk.sh` / `betterdesk.ps1`) automatically detect IPv6-only addresses and attempt to resolve an IPv4 address instead, preventing this issue from occurring during installation.

---

## Problem 4: Relay Connection Failed with Docker Quick Images

### Symptoms

RustDesk clients register successfully, but connections fail with:
```
Failed to connect via relay server: Failed to connect to relay server: Please try later
```

Server logs show relay advertisements like:
```
relay=10.1.0.2:21117
```

or another Docker/container-network address.

### Root Cause

The quick Docker image runs the BetterDesk server inside a bridge network. If the signal server advertises the container's private bridge IP as the relay server, RustDesk clients outside that Docker network cannot connect to it.

### Solution

Set `RELAY_SERVERS` to an address reachable by your clients. Use the Docker host public IP/DNS for internet deployments, or the Docker host LAN IP for LAN-only deployments.

```bash
# Public server
RELAY_SERVERS=203.0.113.10:21117 docker compose up -d

# LAN-only server
RELAY_SERVERS=192.168.1.10:21117 docker compose up -d
```

Then verify that TCP port `21117` is reachable from a client network.

---

## P2P vs relay connections (issue #157)

RustDesk desktop clients normally try **direct P2P** (UDP hole punch) first, then fall back to the **relay server** if NAT/firewall blocks direct traffic.

### How to read server logs

| Log line | Meaning |
|---|---|
| `P2P-first: cancelled relay fallback` | Server deferred relay; target completed hole punch — P2P path is active |
| `PunchHoleResponse forwarded via TCP` | Initiator received punch info to attempt direct connection |
| `RequestRelay` ~1s later | Client could not establish P2P (common with symmetric NAT or blocked UDP) |
| `Pair established` on `[relay]` | Session is using relay (expected fallback when P2P fails) |

Relay fallback after P2P-first is **normal** on restrictive networks. It does not mean P2P is disabled unless `ALWAYS_USE_RELAY=Y` or org policy **Block Direct P2P** is enabled.

### Required ports

| Port | Protocol | Purpose |
|---|---|---|
| 21115 | TCP | NAT type test |
| 21116 | TCP + **UDP** | Signal / hole punching |
| 21117 | TCP | Relay (fallback path) |

Clients need **outbound UDP 21116** to the server (and often between peers after punch). Blocking UDP commonly forces relay even when the server is configured for P2P-first.

### Panel configuration

- **Settings → Connection strategy** — global `P2P first` vs `Relay only` (requires server restart)
- **Policies → Network → Block Direct P2P** — per-organization relay-only enforcement

Web browser remote clients always use relay (no UDP hole punch in browsers).

### Environment variables (Go server)

| Variable | Default | Effect |
|---|---|---|
| `P2P_FIRST=Y` | on | Wait for target hole punch before answering initiator |
| `ALWAYS_USE_RELAY=Y` | off | Skip P2P; force relay for all peers |
| `P2P_FALLBACK_MS` | 2000 | Timeout before relay-capable fallback response |
| `SAME_NAT_RELAY=Y` | on | Force relay when both peers share one public IP |
