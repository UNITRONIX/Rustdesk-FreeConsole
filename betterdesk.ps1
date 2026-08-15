#Requires -RunAsAdministrator
<#
.SYNOPSIS
    BetterDesk Console Manager v3.5.36 - All-in-One Interactive Tool for Windows

.DESCRIPTION
    Features:
      - Fresh installation (Node.js web console)
      - Minimal installation (Go server only, no web console)
      - Update existing installation
      - Repair/fix issues (enhanced with graceful shutdown)
      - Validate installation
      - Backup & restore
      - Reset admin password
      - Build & deploy server (rebuild Go binary with rollback)
      - Full diagnostics
      - SHA256 binary verification
      - Auto mode (non-interactive)
      - Enhanced service management with health verification
      - Port conflict detection
      - Fixed ban system (device-specific, not IP-based)
      - RustDesk Client API (login, address book sync)
      - TOTP Two-Factor Authentication
      - SSL/TLS certificate configuration
      - PostgreSQL database support
      - SQLite to PostgreSQL migration
      - CDAP (Custom Device API Protocol) support

.PARAMETER Auto
    Run installation in automatic mode (non-interactive)

.PARAMETER SkipVerify
    Skip SHA256 verification of binaries

.PARAMETER NodeJs
    Install Node.js web console (default)

.PARAMETER Protocol
    Set protocol mode: 'http' or 'https'

.PARAMETER PostgreSQL
    Use PostgreSQL instead of SQLite

.PARAMETER PgUri
    PostgreSQL connection URI (implies -PostgreSQL)

.PARAMETER RelayMode
    Relay IP selection mode: 'auto' (detect public IP, default), 'local'/'lan'
    (use the server's LAN IP for LAN-only deployments), or 'public'/'wan'
    (force public IP detection). Overridden by -RelayServers / RELAY_SERVERS.

.PARAMETER RelayServers
    Force a fixed relay server address (IP or host[:port]). Always overrides
    -RelayMode. Equivalent to the RELAY_SERVERS environment variable.

.PARAMETER RunAsRoot
    Run the Windows services as LocalSystem (legacy). By default the services
    run under low-privilege per-service virtual accounts (privilege separation).

.EXAMPLE
    .\betterdesk.ps1
    Interactive mode

.EXAMPLE
    .\betterdesk.ps1 -Auto
    Automatic installation with Node.js console and SQLite

.EXAMPLE
    .\betterdesk.ps1 -Auto -PostgreSQL
    Automatic installation with PostgreSQL

.EXAMPLE
    .\betterdesk.ps1 -Auto -RelayMode local
    Automatic LAN-only installation (relay uses the server's local IP)

.EXAMPLE
    .\betterdesk.ps1 -Auto -RelayServers 203.0.113.10
    Automatic installation with a fixed public relay address

.EXAMPLE
    .\betterdesk.ps1 -SkipVerify
    Skip binary verification
#>

param(
    [switch]$Auto,
    [switch]$SkipVerify,
    [switch]$Minimal,
    [switch]$NodeJs,
    [switch]$PostgreSQL,
    [string]$PgUri = "",
    [ValidateSet('http', 'https', '')]
    [string]$Protocol = "",
    [ValidateSet('auto', 'local', 'lan', 'public', 'wan', '')]
    [string]$RelayMode = "",
    [string]$RelayServers = "",
    [switch]$RunAsRoot,
    [switch]$Flask  # Deprecated, kept for backward compatibility
)

#===============================================================================
# Configuration
#===============================================================================

$script:VERSION = "3.5.36"
$script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Auto mode flags
$script:AUTO_MODE = $Auto
$script:SKIP_VERIFY = $SkipVerify
$script:MINIMAL_MODE = $Minimal

# Privilege separation (default). The installer needs Administrator, but the
# services run under low-privilege per-service virtual accounts (NT SERVICE\...)
# instead of LocalSystem. Use -RunAsRoot or BETTERDESK_RUN_AS_ROOT=1 to keep the
# legacy behavior of running services as LocalSystem.
$script:RUN_AS_ROOT = $RunAsRoot -or ($env:BETTERDESK_RUN_AS_ROOT -eq "1") -or ($env:BETTERDESK_RUN_AS_ROOT -eq "true")

# Console type preference
$script:PREFERRED_CONSOLE_TYPE = "nodejs"  # Always Node.js (Flask removed in v2.3.0)
if ($Flask) { 
    Write-Host "WARNING: Flask console is deprecated. Node.js will be installed instead." -ForegroundColor Yellow
    $script:PREFERRED_CONSOLE_TYPE = "nodejs" 
}

# Database configuration
$script:USE_POSTGRESQL = $PostgreSQL -or ($env:USE_POSTGRESQL -eq "true")
$script:POSTGRESQL_URI = if ($PgUri) { $PgUri } elseif ($env:POSTGRESQL_URI) { $env:POSTGRESQL_URI } else { "" }
$script:POSTGRESQL_USER = if ($env:POSTGRESQL_USER) { $env:POSTGRESQL_USER } else { "betterdesk" }
$script:POSTGRESQL_PASS = if ($env:POSTGRESQL_PASS) { $env:POSTGRESQL_PASS } else { "" }
$script:POSTGRESQL_DB = if ($env:POSTGRESQL_DB) { $env:POSTGRESQL_DB } else { "betterdesk" }
$script:POSTGRESQL_HOST = if ($env:POSTGRESQL_HOST) { $env:POSTGRESQL_HOST } else { "localhost" }
$script:POSTGRESQL_PORT = if ($env:POSTGRESQL_PORT) { $env:POSTGRESQL_PORT } else { "5432" }

# Relay server configuration
#   auto   - detect public IP (default, best for internet-facing servers)
#   local  - use the server's LAN IP (best for LAN-only deployments)
#   public - force public IP detection
# RELAY_SERVERS env var (or -RelayServers) always overrides this with a fixed value.
$script:RELAY_MODE = if ($RelayMode) { $RelayMode } elseif ($env:RELAY_MODE) { $env:RELAY_MODE } else { "auto" }
if ($script:RELAY_MODE -eq "lan") { $script:RELAY_MODE = "local" }
if ($script:RELAY_MODE -eq "wan") { $script:RELAY_MODE = "public" }
$script:RELAY_SERVERS = if ($RelayServers) { $RelayServers } elseif ($env:RELAY_SERVERS) { $env:RELAY_SERVERS } else { "" }

# Go server configuration
$script:GO_SERVER_SOURCE = Join-Path $script:ScriptDir "betterdesk-server"
# Must match the toolchain pinned in betterdesk-server/go.mod.
$script:GO_MIN_VERSION = "1.26.5"
$script:GO_DOWNLOAD_VERSION = "1.26.5"
# Legacy Rust checksums (deprecated, kept for migration purposes)
$script:HBBS_WINDOWS_X86_64_SHA256 = "B790FA44CAC7482A057ED322412F6D178FB33F3B05327BFA753416E9879BD62F"
$script:HBBR_WINDOWS_X86_64_SHA256 = "368C71E8D3AEF4C5C65177FBBBB99EA045661697A89CB7C2A703759C575E8E9F"

# Default paths
$script:RUSTDESK_PATH = if ($env:RUSTDESK_PATH) { $env:RUSTDESK_PATH } else { "C:\BetterDesk" }
$script:CONSOLE_PATH = if ($env:CONSOLE_PATH) { $env:CONSOLE_PATH } else { "C:\BetterDeskConsole" }
$script:BACKUP_DIR = if ($env:BACKUP_DIR) { $env:BACKUP_DIR } else { "C:\BetterDesk-Backups" }
$script:DB_PATH = "$script:RUSTDESK_PATH\db_v2.sqlite3"

# API configuration
$script:GO_API_PORT = if ($env:GO_API_PORT) { $env:GO_API_PORT } elseif ($env:API_PORT) { $env:API_PORT } else { "21114" }
$script:CLIENT_API_PORT = if ($env:CLIENT_API_PORT) { $env:CLIENT_API_PORT } else { "21121" }
$script:API_PORT = $script:GO_API_PORT
$script:STORE_ADMIN_CREDENTIALS = ($env:STORE_ADMIN_CREDENTIALS -eq "true")

# Common installation paths to search
$script:COMMON_RUSTDESK_PATHS = @(
    "C:\BetterDesk",
    "C:\RustDesk",
    "C:\Program Files\BetterDesk",
    "C:\Program Files\RustDesk",
    "$env:LOCALAPPDATA\BetterDesk"
)

$script:COMMON_CONSOLE_PATHS = @(
    "C:\BetterDeskConsole",
    "C:\Program Files\BetterDeskConsole",
    "$env:LOCALAPPDATA\BetterDeskConsole"
)

# Service names
$script:SERVER_SERVICE = "BetterDeskServer"    # Go server (replaces HBBS + HBBR)
$script:HBBS_SERVICE = "BetterDeskSignal"      # Legacy Rust signal
$script:HBBR_SERVICE = "BetterDeskRelay"       # Legacy Rust relay
$script:CONSOLE_SERVICE = "BetterDeskConsole"

# Status variables
$script:INSTALL_STATUS = "none"
$script:SERVER_RUNNING = $false  # Go server
$script:HBBS_RUNNING = $false    # Legacy Rust
$script:HBBR_RUNNING = $false    # Legacy Rust
$script:CONSOLE_RUNNING = $false
$script:BINARIES_OK = $false
$script:DATABASE_OK = $false
$script:CONSOLE_TYPE = "none"  # none, nodejs
$script:SERVER_TYPE = "none"    # none, go, rust
# FRESH_INSTALL gates new-install defaults (e.g. managed enrollment mode). It
# stays $false for UPDATE/REPAIR so existing installs keep their current policy.
$script:FRESH_INSTALL = $false
# Logging
$script:LOG_FILE = "$env:TEMP\betterdesk_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"

#===============================================================================
# Helper Functions
#===============================================================================

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$timestamp] $Message" | Out-File -FilePath $script:LOG_FILE -Append -Encoding UTF8
}

function Print-Header {
    Clear-Host
    Write-Host @"
╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║   ██████╗ ███████╗████████╗████████╗███████╗██████╗              ║
║   ██╔══██╗██╔════╝╚══██╔══╝╚══██╔══╝██╔════╝██╔══██╗             ║
║   ██████╔╝█████╗     ██║      ██║   █████╗  ██████╔╝             ║
║   ██╔══██╗██╔══╝     ██║      ██║   ██╔══╝  ██╔══██╗             ║
║   ██████╔╝███████╗   ██║      ██║   ███████╗██║  ██║             ║
║   ╚═════╝ ╚══════╝   ╚═╝      ╚═╝   ╚══════╝╚═╝  ╚═╝             ║
║                    ██████╗ ███████╗███████╗██╗  ██╗              ║
║                    ██╔══██╗██╔════╝██╔════╝██║ ██╔╝              ║
║                    ██║  ██║█████╗  ███████╗█████╔╝               ║
║                    ██║  ██║██╔══╝  ╚════██║██╔═██╗               ║
║                    ██████╔╝███████╗███████║██║  ██╗              ║
║                    ╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝              ║
║                                                                  ║
║                  Console Manager v$($script:VERSION)             ║
╚══════════════════════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  ⚠  WINDOWS SUPPORT: EXPERIMENTAL (Tier 3)" -ForegroundColor Yellow
    Write-Host "     Primary platform: Linux. Report issues at GitHub." -ForegroundColor DarkYellow
    Write-Host ""
}

function Print-Success {
    param([string]$Message)
    Write-Host "[OK] " -ForegroundColor Green -NoNewline
    Write-Host $Message
    Write-Log "SUCCESS: $Message"
}

function Print-Error {
    param([string]$Message)
    Write-Host "[X] " -ForegroundColor Red -NoNewline
    Write-Host $Message
    Write-Log "ERROR: $Message"
}

function Print-Warning {
    param([string]$Message)
    Write-Host "[!] " -ForegroundColor Yellow -NoNewline
    Write-Host $Message
    Write-Log "WARNING: $Message"
}

function Print-Info {
    param([string]$Message)
    Write-Host "[i] " -ForegroundColor Blue -NoNewline
    Write-Host $Message
    Write-Log "INFO: $Message"
}

function Print-Step {
    param([string]$Message)
    Write-Host "[>] " -ForegroundColor Magenta -NoNewline
    Write-Host $Message
    Write-Log "STEP: $Message"
}

function Press-Enter {
    Write-Host ""
    Write-Host "Press Enter to continue..." -ForegroundColor Cyan
    if (-not $script:AUTO_MODE) {
        $null = Read-Host
    }
}

function Confirm-Action {
    param([string]$Prompt = "Continue?")
    if ($script:AUTO_MODE) { return $true }
    
    $response = Read-Host "$Prompt [y/N]"
    return $response -match "^[YyTt]"
}

#===============================================================================
# Interactive TUI (arrow-key navigable menu) — no external dependencies
#===============================================================================
$script:TUI_RESULT = -1
$script:MENU_CHOICE = ''

function Test-TuiAvailable {
    if ($env:BETTERDESK_CLASSIC_MENU -eq '1') { return $false }
    if ($script:AUTO_MODE) { return $false }
    try {
        if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { return $false }
    } catch { return $false }
    return $true
}

# Invoke-TuiSelect -Title T -Subtitle S -Items @("Label`tDesc", ...)
# Navigation: Up/Down or k/j to move, Enter/Right to choose, q/Esc/0 to cancel.
# Returns $true and sets $script:TUI_RESULT on selection, $false on cancel.
function Invoke-TuiSelect {
    param(
        [string]$Title,
        [string]$Subtitle,
        [string[]]$Items
    )
    $script:TUI_RESULT = -1
    $count = $Items.Count
    if (-not (Test-TuiAvailable) -or $count -eq 0) { return $false }

    $sel = 0
    try { [Console]::CursorVisible = $false } catch {}
    Clear-Host
    try {
        while ($true) {
            try { [Console]::SetCursorPosition(0, 0) } catch {}
            Write-Host "+--------------------------------------------------------------+" -ForegroundColor Cyan
            Write-Host ("| {0,-60} |" -f $Title) -ForegroundColor White
            if ($Subtitle) { Write-Host ("| {0,-60} |" -f $Subtitle) -ForegroundColor DarkGray }
            Write-Host "+--------------------------------------------------------------+" -ForegroundColor Cyan
            Write-Host ""

            for ($i = 0; $i -lt $count; $i++) {
                $parts = $Items[$i] -split "`t", 2
                $label = $parts[0]
                $desc  = if ($parts.Count -gt 1) { $parts[1] } else { '' }
                if ($i -eq $sel) {
                    $line = ("  > {0,-30}{1}" -f $label, $desc)
                    Write-Host ($line.PadRight(78)) -ForegroundColor Green
                } else {
                    $line = ("    {0,-30}{1}" -f $label, $desc)
                    Write-Host ($line.PadRight(78)) -ForegroundColor White
                }
            }

            Write-Host ""
            Write-Host ("  Up/Down navigate   Enter select   q/Esc back".PadRight(78)) -ForegroundColor DarkGray

            $key = [Console]::ReadKey($true)
            switch ($key.Key) {
                'UpArrow'    { $sel = (($sel - 1 + $count) % $count) }
                'DownArrow'  { $sel = (($sel + 1) % $count) }
                'Enter'      { $script:TUI_RESULT = $sel; return $true }
                'RightArrow' { $script:TUI_RESULT = $sel; return $true }
                'Escape'     { return $false }
                default {
                    $ch = $key.KeyChar
                    if     ($ch -eq 'k') { $sel = (($sel - 1 + $count) % $count) }
                    elseif ($ch -eq 'j') { $sel = (($sel + 1) % $count) }
                    elseif ($ch -eq 'q' -or $ch -eq 'Q' -or $ch -eq '0') { return $false }
                    elseif ($ch -ge '1' -and $ch -le '9') {
                        $idx = [int]::Parse($ch) - 1
                        if ($idx -lt $count) { $script:TUI_RESULT = $idx; return $true }
                    }
                }
            }
        }
    } finally {
        try { [Console]::CursorVisible = $true } catch {}
    }
}

function Show-PanelHeader {
    param([string]$Title, [string]$Subtitle)
    Clear-Host
    Write-Host "+--------------------------------------------------------------+" -ForegroundColor Cyan
    Write-Host ("| {0,-60} |" -f $Title) -ForegroundColor White
    if ($Subtitle) { Write-Host ("| {0,-60} |" -f $Subtitle) -ForegroundColor DarkGray }
    Write-Host "+--------------------------------------------------------------+" -ForegroundColor Cyan
    Write-Host ""
}

# Invoke-MenuChoose -Title T -Subtitle S -Items @(...) -Returns @(...)
# Uses the arrow-key TUI when available, a styled numeric prompt otherwise.
# The chosen token is stored in $script:MENU_CHOICE; on cancel the last entry
# is returned so existing switch blocks can treat it as "back".
function Invoke-MenuChoose {
    param(
        [string]$Title,
        [string]$Subtitle,
        [string[]]$Items,
        [string[]]$Returns
    )
    $script:MENU_CHOICE = ''
    $lastIdx = $Returns.Count - 1
    if ($lastIdx -lt 0) { $lastIdx = 0 }

    if (Test-TuiAvailable) {
        if (Invoke-TuiSelect -Title $Title -Subtitle $Subtitle -Items $Items) {
            $script:MENU_CHOICE = $Returns[$script:TUI_RESULT]
        } else {
            $script:MENU_CHOICE = $Returns[$lastIdx]
        }
        return
    }

    Show-PanelHeader $Title $Subtitle
    for ($i = 0; $i -lt $Items.Count; $i++) {
        $parts = $Items[$i] -split "`t", 2
        $label = $parts[0]
        $desc  = if ($parts.Count -gt 1) { $parts[1] } else { '' }
        Write-Host ("  {0,2}) " -f $Returns[$i]) -ForegroundColor Green -NoNewline
        Write-Host ("{0,-28}" -f $label) -NoNewline
        Write-Host " $desc" -ForegroundColor DarkGray
    }
    Write-Host ""
    $script:MENU_CHOICE = Read-Host "  Select option"
}

function Get-PublicIP {
    # Prefer IPv4 endpoints first: many RustDesk clients cannot use IPv6-only relay.
    $endpoints = @(
        "https://ipv4.icanhazip.com",
        "https://ifconfig.me/ip",
        "https://icanhazip.com"
    )
    foreach ($url in $endpoints) {
        try {
            $ip = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10).Content.Trim()
            if ($ip) { return $ip }
        } catch {}
    }
    return "127.0.0.1"
}

# Detect the server's primary LAN/private IPv4 address.
# Used for LAN-only deployments where the public IP is unreachable by clients.
function Get-LocalIP {
    try {
        # Primary: source address used to reach an external destination
        $route = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
            Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
            Select-Object -First 1
        if ($route -and $route.IPv4Address) {
            return $route.IPv4Address.IPAddress
        }
    } catch {}
    try {
        # Fallback: first non-loopback, non-APIPA IPv4 address
        $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
            Select-Object -First 1
        if ($ip) { return $ip.IPAddress }
    } catch {}
    return "127.0.0.1"
}

function Resolve-ConnectionModeEnv {
    $mode = if ($env:CONNECTION_MODE) { $env:CONNECTION_MODE } else { "p2p_first" }
    if (-not $script:AUTO_MODE -and -not $env:CONNECTION_MODE_SET) {
        Write-Host ""
        Print-Info "Connection strategy: P2P hole punch vs relay-only routing."
        Write-Host "  1) P2P first (recommended) — try direct, fall back to relay" -ForegroundColor Cyan
        Write-Host "  2) Relay only — all sessions via relay server" -ForegroundColor Cyan
        $choice = Read-Host "  Select connection mode [1]"
        if ($choice -eq "2") { $mode = "relay_only" } else { $mode = "p2p_first" }
        Write-Host ""
    }

    $fallbackMs = if ($env:P2P_FALLBACK_MS) { $env:P2P_FALLBACK_MS } else { "2000" }
    $sameNat = if ($env:SAME_NAT_RELAY) { $env:SAME_NAT_RELAY } else { "Y" }

    if ($mode -eq "relay_only") {
        $p2pFirst = "N"
        $alwaysRelay = "Y"
    } else {
        $p2pFirst = "Y"
        $alwaysRelay = "N"
    }

    Print-Info "Connection mode: $mode (P2P_FIRST=$p2pFirst, ALWAYS_USE_RELAY=$alwaysRelay)"
    return @(
        "P2P_FIRST=$p2pFirst",
        "ALWAYS_USE_RELAY=$alwaysRelay",
        "P2P_FALLBACK_MS=$fallbackMs",
        "SAME_NAT_RELAY=$sameNat"
    )
}

# Resolve the relay server address according to RELAY_MODE / RELAY_SERVERS.
# Returns the resolved address; warnings are written to the host (not the value).
function Resolve-RelayIp {
    # Explicit override always wins
    if ($script:RELAY_SERVERS) {
        Print-Info "Using fixed relay address (RelayServers): $($script:RELAY_SERVERS)"
        return $script:RELAY_SERVERS
    }

    $ip = ""
    switch ($script:RELAY_MODE) {
        "local" {
            $ip = Get-LocalIP
            Print-Info "Relay mode 'local': using LAN IP $ip (LAN-only deployment)"
        }
        "public" {
            $ip = Get-PublicIP
            Print-Info "Relay mode 'public': using public IP $ip"
        }
        default {
            $ip = Get-PublicIP
            if ($ip -eq "127.0.0.1" -or $ip -match '^10\.' -or $ip -match '^192\.168\.' -or $ip -match '^172\.(1[6-9]|2[0-9]|3[0-1])\.') {
                Print-Warning "Auto-detected private/loopback IP: $ip"
                Print-Warning "Remote (internet) clients will NOT connect via relay with this address."
                Print-Warning "For LAN-only use this is fine. For internet access run with: -RelayServers YOUR.PUBLIC.IP"
                Print-Warning "To use the LAN IP explicitly run with: -RelayMode local"
            }
        }
    }
    return $ip
}

function Generate-RandomPassword {
    param([int]$Length = 16)
    $chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    $password = -join ((1..$Length) | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
    return $password
}

#===============================================================================
# Detection Functions
#===============================================================================

function Detect-Installation {
    $script:INSTALL_STATUS = "none"
    $script:SERVER_RUNNING = $false
    $script:HBBS_RUNNING = $false
    $script:HBBR_RUNNING = $false
    $script:CONSOLE_RUNNING = $false
    $script:BINARIES_OK = $false
    $script:DATABASE_OK = $false
    $script:CONSOLE_TYPE = "none"
    $script:SERVER_TYPE = "none"
    
    # Check paths and binary type
    if (Test-Path $script:RUSTDESK_PATH) {
        # Check for Go server first
        if (Test-Path "$script:RUSTDESK_PATH\betterdesk-server.exe") {
            $script:BINARIES_OK = $true
            $script:SERVER_TYPE = "go"
            $script:INSTALL_STATUS = "partial"
        }
        # Fallback: Check for legacy Rust binaries
        elseif ((Test-Path "$script:RUSTDESK_PATH\hbbs.exe") -or (Test-Path "$script:RUSTDESK_PATH\hbbs-v8-api.exe")) {
            $script:BINARIES_OK = $true
            $script:SERVER_TYPE = "rust"
            $script:INSTALL_STATUS = "partial"
            Print-Warning "Legacy Rust binaries detected. Consider upgrading to Go server."
        }
    }
    
    # Check database (SQLite file or PostgreSQL)
    $detectedDbType = "sqlite"
    $envFile = Join-Path $script:CONSOLE_PATH ".env"
    if (Test-Path $envFile) {
        $dbTypeLine = Select-String -Path $envFile -Pattern '^DB_TYPE=' -SimpleMatch | Select-Object -First 1
        if ($dbTypeLine) {
            $detectedDbType = ($dbTypeLine.Line -split '=', 2)[1].Trim()
        }
    }

    if ($detectedDbType -eq "postgres") {
        # PostgreSQL: we trust the config -- full validation is done by Do-Validate
        $script:DATABASE_OK = $true
    } elseif (Test-Path "$script:RUSTDESK_PATH\db_v2.sqlite3") {
        $script:DATABASE_OK = $true
    }
    
    # Detect console type
    if (Test-Path $script:CONSOLE_PATH) {
        if ((Test-Path "$script:CONSOLE_PATH\server.js") -or (Test-Path "$script:CONSOLE_PATH\package.json")) {
            $script:CONSOLE_TYPE = "nodejs"
        } elseif (Test-Path "$script:CONSOLE_PATH\app.py") {
            $script:CONSOLE_TYPE = "nodejs"  # Legacy Flask, will be migrated
            Print-Warning "Legacy Flask console detected. Will be migrated to Node.js on update."
        }
        
        if ($script:CONSOLE_TYPE -ne "none" -and $script:BINARIES_OK) {
            $script:INSTALL_STATUS = "complete"
        }
    }
    
    # Check services - Go server first
    $serverService = Get-Service -Name $script:SERVER_SERVICE -ErrorAction SilentlyContinue
    if ($serverService -and $serverService.Status -eq 'Running') {
        $script:SERVER_RUNNING = $true
        $script:HBBS_RUNNING = $true  # Go handles both
        $script:HBBR_RUNNING = $true
    } else {
        # Check legacy Rust services
        $hbbsService = Get-Service -Name $script:HBBS_SERVICE -ErrorAction SilentlyContinue
        if ($hbbsService -and $hbbsService.Status -eq 'Running') {
            $script:HBBS_RUNNING = $true
        }
        
        $hbbrService = Get-Service -Name $script:HBBR_SERVICE -ErrorAction SilentlyContinue
        if ($hbbrService -and $hbbrService.Status -eq 'Running') {
            $script:HBBR_RUNNING = $true
        }
    }
    
    $consoleService = Get-Service -Name $script:CONSOLE_SERVICE -ErrorAction SilentlyContinue
    if ($consoleService -and $consoleService.Status -eq 'Running') {
        $script:CONSOLE_RUNNING = $true
    }
}

# Preserve database configuration from existing .env file
# This MUST be called before Install-NodeJsConsole during UPDATE/REPAIR
# to prevent switching from PostgreSQL to SQLite
function Preserve-DatabaseConfig {
    $envFile = Join-Path $script:CONSOLE_PATH ".env"
    
    if (Test-Path $envFile) {
        # Read existing DB_TYPE
        $dbTypeLine = Select-String -Path $envFile -Pattern '^DB_TYPE=' -SimpleMatch | Select-Object -First 1
        $existingDbType = if ($dbTypeLine) { ($dbTypeLine.Line -split '=', 2)[1].Trim() } else { "" }
        
        # Read existing DATABASE_URL
        $dbUrlLine = Select-String -Path $envFile -Pattern '^DATABASE_URL=' -SimpleMatch | Select-Object -First 1
        $existingDbUrl = if ($dbUrlLine) { ($dbUrlLine.Line -split '=', 2)[1].Trim() } else { "" }
        
        if ($existingDbType -eq "postgres" -and $existingDbUrl) {
            $script:USE_POSTGRESQL = $true
            $script:POSTGRESQL_URI = $existingDbUrl
            Print-Info "Preserving PostgreSQL configuration from existing .env"
        } elseif ($existingDbType -eq "sqlite") {
            $script:USE_POSTGRESQL = $false
            $script:POSTGRESQL_URI = ""
            Print-Info "Preserving SQLite configuration from existing .env"
        }
    }
}

# Write or merge console .env from web-nodejs/.env.example (issue #158).
function Merge-ConsoleEnv {
    param(
        [bool]$FreshInstall = $false
    )

    $mergeScript = Join-Path $script:CONSOLE_PATH "scripts\merge-env.js"
    if (-not (Test-Path $mergeScript)) {
        $mergeScript = Join-Path $script:ScriptDir "web-nodejs\scripts\merge-env.js"
    }
    if (-not (Test-Path $mergeScript)) {
        Print-Error "merge-env.js not found — cannot configure .env"
        return $false
    }

    $sslDir = Join-Path $script:RUSTDESK_PATH "ssl"
    $dbType = "sqlite"
    $databaseUrl = ""
    if ($script:USE_POSTGRESQL -and $script:POSTGRESQL_URI) {
        $dbType = "postgres"
        $databaseUrl = $script:POSTGRESQL_URI
    }

    $adminPassword = $env:ADMIN_PASSWORD
    $sessionSecret = ""

    if ($FreshInstall) {
        if (-not $adminPassword) {
            $adminPassword = Generate-RandomPassword
        }
        $sessionSecret = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
    } else {
        $envFile = Join-Path $script:CONSOLE_PATH ".env"
        if (Test-Path $envFile) {
            $ssLine = Select-String -Path $envFile -Pattern '^SESSION_SECRET=' -SimpleMatch | Select-Object -First 1
            $sessionSecret = if ($ssLine) { ($ssLine.Line -split '=', 2)[1].Trim() } else { "" }
            if (-not $adminPassword) {
                $apLine = Select-String -Path $envFile -Pattern '^DEFAULT_ADMIN_PASSWORD=' -SimpleMatch | Select-Object -First 1
                $adminPassword = if ($apLine) { ($apLine.Line -split '=', 2)[1].Trim() } else { "" }
            }
        }
        if (-not $sessionSecret) {
            $sessionSecret = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
        }
    }

    $goPort = if ($script:GO_API_PORT) { $script:GO_API_PORT } else { 21114 }
    $clientPort = if ($script:CLIENT_API_PORT) { $script:CLIENT_API_PORT } else { 21121 }
    $dataDir = Join-Path $script:CONSOLE_PATH "data"

    $substScript = Join-Path $script:CONSOLE_PATH "scripts\write-installer-env-subst.js"
    if (-not (Test-Path $substScript)) {
        $substScript = Join-Path $script:ScriptDir "web-nodejs\scripts\write-installer-env-subst.js"
    }
    $substFile = Join-Path $env:TEMP "betterdesk-env-subst-$PID.json"

    $env:BD_SUBST_RUSTDESK_DIR = $script:RUSTDESK_PATH
    $env:BD_SUBST_PUB_KEY_PATH = Join-Path $script:RUSTDESK_PATH "id_ed25519.pub"
    $env:BD_SUBST_API_KEY_PATH = Join-Path $script:RUSTDESK_PATH ".api_key"
    $env:BD_SUBST_DB_TYPE = $dbType
    $env:BD_SUBST_DB_PATH = Join-Path $script:RUSTDESK_PATH "db_v2.sqlite3"
    $env:BD_SUBST_DATABASE_URL = $databaseUrl
    $env:BD_SUBST_DATA_DIR = $dataDir
    $env:BD_SUBST_GO_API_PORT = [string]$goPort
    $env:BD_SUBST_HBBS_API_URL = "http://localhost:${goPort}/api"
    $env:BD_SUBST_BETTERDESK_API_URL = "http://localhost:${goPort}/api"
    $env:BD_SUBST_API_PORT = [string]$clientPort
    $env:BD_SUBST_DEFAULT_ADMIN_PASSWORD = [string]$adminPassword
    $env:BD_SUBST_SESSION_SECRET = [string]$sessionSecret
    $env:BD_SUBST_SSL_CERT_PATH = Join-Path $sslDir "betterdesk.crt"
    $env:BD_SUBST_SSL_KEY_PATH = Join-Path $sslDir "betterdesk.key"

    if (-not (Test-Path $substScript)) {
        Print-Error "write-installer-env-subst.js not found"
        return $false
    }
    & node $substScript $substFile 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $substFile)) {
        Print-Error "Failed to build .env substitution file"
        return $false
    }

    $nodeArgs = @(
        $mergeScript,
        "--target", (Join-Path $script:CONSOLE_PATH ".env"),
        "--subst-file", $substFile
    )
    if ($FreshInstall) { $nodeArgs += "--fresh" }

    $output = & node @nodeArgs 2>&1
    Remove-Item -Path $substFile -Force -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) {
        Print-Error "Failed to write .env via merge-env.js: $output"
        return $false
    }

    if ($FreshInstall) {
        Print-Info "Created .env configuration file (fresh install)"
    } else {
        Print-Info "Merged new .env keys (existing settings preserved)"
    }
    return $true
}

function Auto-DetectPaths {
    $found = $false
    
    # Check configured path first - Go server or legacy Rust
    if ($script:RUSTDESK_PATH -and (Test-Path $script:RUSTDESK_PATH)) {
        if ((Test-Path "$script:RUSTDESK_PATH\betterdesk-server.exe") -or 
            (Test-Path "$script:RUSTDESK_PATH\hbbs.exe") -or 
            (Test-Path "$script:RUSTDESK_PATH\hbbs-v8-api.exe")) {
            Print-Info "Using configured RustDesk path: $script:RUSTDESK_PATH"
            $found = $true
        }
    }
    
    # Auto-detect if not found
    if (-not $found) {
        foreach ($path in $script:COMMON_RUSTDESK_PATHS) {
            if ((Test-Path $path) -and 
                ((Test-Path "$path\betterdesk-server.exe") -or 
                 (Test-Path "$path\hbbs.exe") -or 
                 (Test-Path "$path\hbbs-v8-api.exe"))) {
                $script:RUSTDESK_PATH = $path
                Print-Success "Detected RustDesk installation: $script:RUSTDESK_PATH"
                $found = $true
                break
            }
        }
    }
    
    # Default path for new installations
    if (-not $found) {
        $script:RUSTDESK_PATH = "C:\BetterDesk"
        Print-Info "No installation detected. Default path: $script:RUSTDESK_PATH"
    }
    
    # Auto-detect Console path and type
    $consoleFound = $false
    $script:CONSOLE_TYPE = "none"
    
    foreach ($path in $script:COMMON_CONSOLE_PATHS) {
        # Check for Node.js console first (server.js or package.json)
        if ((Test-Path $path) -and ((Test-Path "$path\server.js") -or (Test-Path "$path\package.json"))) {
            $script:CONSOLE_PATH = $path
            $script:CONSOLE_TYPE = "nodejs"
            Print-Success "Detected Node.js Console: $script:CONSOLE_PATH"
            $consoleFound = $true
            break
        }
        # Check for legacy Flask/Python console (app.py) - migrate to Node.js
        if ((Test-Path $path) -and (Test-Path "$path\app.py") -and -not (Test-Path "$path\server.js")) {
            $script:CONSOLE_PATH = $path
            $script:CONSOLE_TYPE = "nodejs"  # Will be migrated
            Print-Warning "Legacy Flask console detected at $path. Will be migrated to Node.js."
            $consoleFound = $true
            break
        }
    }
    
    if (-not $consoleFound) {
        $script:CONSOLE_PATH = "C:\BetterDeskConsole"
    }
    
    # Update DB_PATH
    $script:DB_PATH = "$script:RUSTDESK_PATH\db_v2.sqlite3"
}

function Print-Status {
    Detect-Installation
    
    Write-Host ""
    Write-Host "=== System Status ===" -ForegroundColor White
    Write-Host ""
    Write-Host "  System:       " -NoNewline; Write-Host "Windows $([System.Environment]::OSVersion.Version)" -ForegroundColor Cyan
    Write-Host "  Architecture: " -NoNewline; Write-Host $env:PROCESSOR_ARCHITECTURE -ForegroundColor Cyan
    Write-Host ""
    
    Write-Host "=== Configured Paths ===" -ForegroundColor White
    Write-Host ""
    Write-Host "  RustDesk:     " -NoNewline; Write-Host $script:RUSTDESK_PATH -ForegroundColor Cyan
    Write-Host "  Console:      " -NoNewline; Write-Host $script:CONSOLE_PATH -ForegroundColor Cyan
    Write-Host "  Database:     " -NoNewline; Write-Host $script:DB_PATH -ForegroundColor Cyan
    Write-Host ""
    
    Write-Host "=== Installation Status ===" -ForegroundColor White
    Write-Host ""
    
    switch ($script:INSTALL_STATUS) {
        "complete" { Write-Host "  Status:       " -NoNewline; Write-Host "[OK] Installed" -ForegroundColor Green }
        "partial"  { Write-Host "  Status:       " -NoNewline; Write-Host "[!] Partial installation" -ForegroundColor Yellow }
        "none"     { Write-Host "  Status:       " -NoNewline; Write-Host "[X] Not installed" -ForegroundColor Red }
    }
    
    if ($script:BINARIES_OK) {
        $serverLabel = if ($script:SERVER_TYPE -eq "go") { " (Go: signal + relay + API)" } else { " (Legacy Rust)" }
        Write-Host "  Server:       " -NoNewline; Write-Host "[OK]$serverLabel" -ForegroundColor Green
    } else {
        Write-Host "  Server:       " -NoNewline; Write-Host "[X] Not found" -ForegroundColor Red
    }
    
    if ($script:DATABASE_OK) {
        Write-Host "  Database:     " -NoNewline; Write-Host "[OK]" -ForegroundColor Green
    } else {
        Write-Host "  Database:     " -NoNewline; Write-Host "[X] Not found" -ForegroundColor Red
    }
    
    if (Test-Path $script:CONSOLE_PATH) {
        $consoleTypeLabel = switch ($script:CONSOLE_TYPE) {
            "nodejs" { " (Node.js)" }
            default { "" }
        }
        Write-Host "  Web Console:  " -NoNewline; Write-Host "[OK]$consoleTypeLabel" -ForegroundColor Green
    } else {
        Write-Host "  Web Console:  " -NoNewline; Write-Host "[X] Not found" -ForegroundColor Red
    }
    
    Write-Host ""
    Write-Host "=== Services Status ===" -ForegroundColor White
    Write-Host ""
    
    # Check if using Go server or legacy Rust
    if ($script:SERVER_RUNNING -or $script:SERVER_TYPE -eq "go") {
        if ($script:SERVER_RUNNING) {
            Write-Host "  BetterDesk Server (Go): " -NoNewline; Write-Host "* Active (Signal + Relay + API)" -ForegroundColor Green
        } else {
            # Check service state for better diagnostics
            $svc = Get-Service -Name $script:SERVER_SERVICE -ErrorAction SilentlyContinue
            if ($svc -and $svc.Status -eq 'Stopped') {
                Write-Host "  BetterDesk Server (Go): " -NoNewline; Write-Host "o Stopped" -ForegroundColor Red
                Write-Host "    Hint: Check logs at $script:RUSTDESK_PATH\logs\server_error.log" -ForegroundColor Yellow
            } else {
                Write-Host "  BetterDesk Server (Go): " -NoNewline; Write-Host "o Inactive" -ForegroundColor Red
            }
        }
    } else {
        # Legacy Rust services
        if ($script:HBBS_RUNNING) {
            Write-Host "  HBBS (Signal): " -NoNewline; Write-Host "* Active " -ForegroundColor Green -NoNewline
            Write-Host "(Legacy Rust)" -ForegroundColor Yellow
        } else {
            Write-Host "  HBBS (Signal): " -NoNewline; Write-Host "o Inactive" -ForegroundColor Red
        }
        
        if ($script:HBBR_RUNNING) {
            Write-Host "  HBBR (Relay):  " -NoNewline; Write-Host "* Active " -ForegroundColor Green -NoNewline
            Write-Host "(Legacy Rust)" -ForegroundColor Yellow
        } else {
            Write-Host "  HBBR (Relay):  " -NoNewline; Write-Host "o Inactive" -ForegroundColor Red
        }
    }
    
    if ($script:CONSOLE_RUNNING) {
        Write-Host "  Web Console:   " -NoNewline; Write-Host "* Active" -ForegroundColor Green
    } else {
        $consoleSvc = Get-Service -Name $script:CONSOLE_SERVICE -ErrorAction SilentlyContinue
        if ($consoleSvc -and $consoleSvc.Status -eq 'Stopped') {
            Write-Host "  Web Console:   " -NoNewline; Write-Host "o Stopped" -ForegroundColor Red
            Write-Host "    Hint: Check logs at $script:CONSOLE_PATH\logs\console_error.log" -ForegroundColor Yellow
        } else {
            Write-Host "  Web Console:   " -NoNewline; Write-Host "o Inactive" -ForegroundColor Red
        }
    }
    
    Write-Host ""
}

#===============================================================================
# Go Installation and Compilation Functions
#===============================================================================

function Get-GoVersionPart {
    param(
        [string]$Version,
        [int]$Index = 0
    )
    $normalized = ($Version -replace '[^0-9.]', '')
    $parts = $normalized -split '\.'
    if ($Index -lt $parts.Count -and $parts[$Index] -match '^\d+$') {
        return [int]$parts[$Index]
    }
    return 0
}

function Test-GoInstalled {
    $goCmd = Get-Command go -ErrorAction SilentlyContinue
    if (-not $goCmd) {
        return $false
    }
    
    $goVersionOutput = & go version 2>&1
    $goMatch = [regex]::Match($goVersionOutput, 'go(\d+)\.(\d+)(?:\.(\d+))?')
    if (-not $goMatch.Success) {
        return $false
    }

    $goVersion = $goMatch.Groups[0].Value.Replace('go', '')
    $currentMajor = [int]$goMatch.Groups[1].Value
    $currentMinor = [int]$goMatch.Groups[2].Value
    $currentPatch = if ($goMatch.Groups[3].Success) { [int]$goMatch.Groups[3].Value } else { 0 }

    # Security hardening: reject vulnerable Go 1.26.0 stdlib.
    if ($currentMajor -eq 1 -and $currentMinor -eq 26 -and $currentPatch -eq 0) {
        Print-Warning "Detected vulnerable Go version $goVersion (known stdlib CVEs)."
        return $false
    }
    $minMajor = Get-GoVersionPart -Version $script:GO_MIN_VERSION -Index 0
    $minMinor = Get-GoVersionPart -Version $script:GO_MIN_VERSION -Index 1
    $minPatch = Get-GoVersionPart -Version $script:GO_MIN_VERSION -Index 2
    
    if ($currentMajor -gt $minMajor -or
        ($currentMajor -eq $minMajor -and $currentMinor -gt $minMinor) -or
        ($currentMajor -eq $minMajor -and $currentMinor -eq $minMinor -and $currentPatch -ge $minPatch)) {
        return $true
    }
    
    Print-Warning "Go version $goVersion is older than required $script:GO_MIN_VERSION"
    return $false
}

function Install-Golang {
    Print-Step "Installing Go toolchain..."
    
    $goVersion = $script:GO_DOWNLOAD_VERSION
    $goUrl = "https://go.dev/dl/go$goVersion.windows-amd64.zip"
    $goZip = Join-Path $env:TEMP "go$goVersion.zip"
    $goRoot = "C:\Go"
    
    Print-Info "Downloading Go $goVersion..."
    try {
        Invoke-WebRequest -Uri $goUrl -OutFile $goZip -UseBasicParsing
    } catch {
        Print-Error "Failed to download Go: $_"
        return $false
    }
    
    Print-Info "Extracting Go..."
    if (Test-Path $goRoot) {
        Remove-Item -Path $goRoot -Recurse -Force
    }
    
    Expand-Archive -Path $goZip -DestinationPath "C:\" -Force
    Remove-Item -Path $goZip -Force
    
    # Add to PATH if not already there
    $envPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $goPath = "$goRoot\bin"
    if ($envPath -notlike "*$goPath*") {
        [Environment]::SetEnvironmentVariable("Path", "$envPath;$goPath", "Machine")
        $env:Path = "$env:Path;$goPath"
    }
    
    # Verify installation
    if (Test-GoInstalled) {
        Print-Success "Go $goVersion installed successfully"
        return $true
    } else {
        Print-Error "Go installation verification failed"
        return $false
    }
}

function Compile-GoServer {
    Print-Step "Compiling BetterDesk Go Server..."
    
    if (-not (Test-Path $script:GO_SERVER_SOURCE)) {
        Print-Error "Go server source not found at: $script:GO_SERVER_SOURCE"
        return $false
    }
    
    $currentDir = Get-Location
    Set-Location $script:GO_SERVER_SOURCE
    
    Print-Info "Running 'go mod tidy'..."
    & go mod tidy 2>&1 | ForEach-Object { Write-Host "  $_" }
    
    Print-Info "Building static binary..."
    $env:CGO_ENABLED = "0"
    $env:GOOS = "windows"
    $env:GOARCH = "amd64"
    
    & go build -ldflags="-s -w" -o "betterdesk-server.exe" . 2>&1 | ForEach-Object { Write-Host "  $_" }
    
    Set-Location $currentDir
    
    $outputBinary = Join-Path $script:GO_SERVER_SOURCE "betterdesk-server.exe"
    if (Test-Path $outputBinary) {
        $size = [math]::Round((Get-Item $outputBinary).Length / 1MB, 2)
        Print-Success "Build successful: betterdesk-server.exe ($size MB)"
        return $true
    } else {
        Print-Error "Build failed - binary not created"
        return $false
    }
}

#===============================================================================
# Binary Verification Functions
#===============================================================================

function Verify-BinaryChecksum {
    param(
        [string]$FilePath,
        [string]$ExpectedHash
    )
    
    $fileName = Split-Path -Leaf $FilePath
    
    if (-not (Test-Path $FilePath)) {
        Print-Error "File not found: $FilePath"
        return $false
    }
    
    Print-Info "Verifying $fileName..."
    $actualHash = (Get-FileHash -Path $FilePath -Algorithm SHA256).Hash.ToUpper()
    
    if ($actualHash -eq $ExpectedHash.ToUpper()) {
        Print-Success "$fileName`: SHA256 OK"
        return $true
    } else {
        Print-Error "$fileName`: SHA256 MISMATCH!"
        Print-Error "  Expected: $ExpectedHash"
        Print-Error "  Got:      $actualHash"
        return $false
    }
}

function Verify-GoBinary {
    Print-Step "Verifying Go server binary..."
    
    $goBinary = Join-Path $script:GO_SERVER_SOURCE "betterdesk-server.exe"
    
    if (-not (Test-Path $goBinary)) {
        Print-Error "Go binary not found: $goBinary"
        return $false
    }
    
    # Verify it's a valid Windows executable
    try {
        $peHeader = [System.IO.File]::ReadAllBytes($goBinary)[0..1]
        if ($peHeader[0] -eq 0x4D -and $peHeader[1] -eq 0x5A) {  # MZ header
            $size = [math]::Round((Get-Item $goBinary).Length / 1MB, 2)
            Print-Success "Go binary valid: betterdesk-server.exe ($size MB)"
            return $true
        }
    } catch {
        Print-Error "Failed to read binary: $_"
        return $false
    }
    
    Print-Error "Invalid binary format"
    return $false
}

function Verify-Binaries {
    Print-Step "Verifying BetterDesk binaries..."
    
    if ($script:SKIP_VERIFY) {
        Print-Warning "Verification skipped (-SkipVerify)"
        return $true
    }
    
    # Check for Go binary first
    $goBinary = Join-Path $script:GO_SERVER_SOURCE "betterdesk-server.exe"
    
    if (Test-Path $goBinary) {
        return Verify-GoBinary
    }
    
    # Fallback: Check legacy Rust binaries
    $binSource = Join-Path $script:ScriptDir "hbbs-patch-v2"
    $errors = 0
    
    $hbbsPath = Join-Path $binSource "hbbs-windows-x86_64.exe"
    $hbbrPath = Join-Path $binSource "hbbr-windows-x86_64.exe"
    
    if (Test-Path $hbbsPath) {
        if (-not (Verify-BinaryChecksum -FilePath $hbbsPath -ExpectedHash $script:HBBS_WINDOWS_X86_64_SHA256)) {
            $errors++
        }
    }
    
    if (Test-Path $hbbrPath) {
        if (-not (Verify-BinaryChecksum -FilePath $hbbrPath -ExpectedHash $script:HBBR_WINDOWS_X86_64_SHA256)) {
            $errors++
        }
    }
    
    if ($errors -gt 0) {
        Print-Error "Binary verification failed! $errors error(s)"
        Print-Warning "Binaries may be corrupted or outdated."
        if (-not $script:AUTO_MODE) {
            if (-not (Confirm-Action "Continue anyway?")) {
                return $false
            }
        } else {
            return $false
        }
    } else {
        Print-Success "All binaries verified"
    }
    
    return $true
}

#===============================================================================
# Installation Functions
#===============================================================================

function Install-Dependencies {
    Print-Step "Checking dependencies..."
    
    # Check Python
    $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCmd) {
        Print-Warning "Python not found! Please install Python 3.8+ from python.org"
        Print-Info "Download: https://www.python.org/downloads/"
        if (-not $script:AUTO_MODE) {
            Press-Enter
        }
        return $false
    }
    
    $pythonVersion = python --version 2>&1
    Print-Info "Python: $pythonVersion"
    
    # Check pip
    try {
        $null = python -m pip --version 2>&1
        Print-Success "pip is available"
    } catch {
        Print-Warning "pip not found, attempting to install..."
        python -m ensurepip --upgrade
    }
    
    # Install bcrypt for password hashing (used by reset-password fallback)
    Print-Step "Installing Python packages..."
    python -m pip install --quiet --upgrade pip
    python -m pip install --quiet bcrypt requests
    
    Print-Success "Dependencies installed"
    return $true
}

#===============================================================================
# Node.js Installation Functions
#===============================================================================

function Install-NodeJs {
    Print-Step "Checking Node.js installation..."
    
    # Check if Node.js is already installed and version is sufficient
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $nodeVersion = (node --version) -replace 'v', '' -split '\.' | Select-Object -First 1
        if ([int]$nodeVersion -ge 22) {
            Print-Success "Node.js v$(node --version) already installed"
            return $true
        } else {
            Print-Warning "Node.js version $nodeVersion is too old (need 22+). Upgrading..."
        }
    }
    
    Print-Step "Installing Node.js 24 LTS..."
    
    # Try winget first (Windows 10/11)
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetCmd) {
        Print-Info "Installing via winget..."
        try {
            winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
            # Refresh PATH
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
            Print-Success "Node.js installed via winget"
            return $true
        } catch {
            Print-Warning "winget installation failed, trying alternative method..."
        }
    }
    
    # Try chocolatey
    $chocoCmd = Get-Command choco -ErrorAction SilentlyContinue
    if ($chocoCmd) {
        Print-Info "Installing via Chocolatey..."
        try {
            choco install nodejs-lts -y
            # Refresh PATH
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
            Print-Success "Node.js installed via Chocolatey"
            return $true
        } catch {
            Print-Warning "Chocolatey installation failed..."
        }
    }
    
    # Manual download as last resort
    Print-Warning "Automatic installation not available."
    Print-Info "Please install Node.js 24 LTS manually from: https://nodejs.org/"
    Print-Info "After installation, restart the script."
    return $false
}

#===============================================================================
# PostgreSQL Functions
#===============================================================================

function Choose-DatabaseType {
    if ($script:AUTO_MODE) {
        if ($script:USE_POSTGRESQL) {
            Print-Info "Auto mode: Using PostgreSQL"
        } else {
            Print-Info "Auto mode: Using SQLite (default)"
        }
        return
    }
    
    Write-Host ""
    $items = @(
        "SQLite`tSingle-file DB, zero setup (recommended)",
        "PostgreSQL`tProduction backend with connection pooling"
    )
    $returns = @("1", "2")
    Invoke-MenuChoose -Title "Select Database Type" -Subtitle "SQLite is recommended for most installs" -Items $items -Returns $returns
    $dbChoice = $script:MENU_CHOICE
    if ([string]::IsNullOrEmpty($dbChoice)) { $dbChoice = "1" }
    
    switch ($dbChoice) {
        "2" {
            $script:USE_POSTGRESQL = $true
            Print-Info "Selected: PostgreSQL"
            
            Write-Host ""
            $pgHost = Read-Host "PostgreSQL host [$($script:POSTGRESQL_HOST)]"
            if (![string]::IsNullOrEmpty($pgHost)) { $script:POSTGRESQL_HOST = $pgHost }
            
            $pgPort = Read-Host "PostgreSQL port [$($script:POSTGRESQL_PORT)]"
            if (![string]::IsNullOrEmpty($pgPort)) { $script:POSTGRESQL_PORT = $pgPort }
            
            $pgDb = Read-Host "PostgreSQL database [$($script:POSTGRESQL_DB)]"
            if (![string]::IsNullOrEmpty($pgDb)) { $script:POSTGRESQL_DB = $pgDb }
            
            $pgUser = Read-Host "PostgreSQL user [$($script:POSTGRESQL_USER)]"
            if (![string]::IsNullOrEmpty($pgUser)) { $script:POSTGRESQL_USER = $pgUser }
            
            $pgPass = Read-Host "PostgreSQL password (leave empty to generate)" -AsSecureString
            $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($pgPass)
            $script:POSTGRESQL_PASS = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
        }
        default {
            $script:USE_POSTGRESQL = $false
            Print-Info "Selected: SQLite"
        }
    }
}

function Setup-PostgreSQLDatabase {
    Print-Step "Setting up PostgreSQL database for BetterDesk..."
    
    # Generate password if not set
    if ([string]::IsNullOrEmpty($script:POSTGRESQL_PASS)) {
        $script:POSTGRESQL_PASS = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 16 | ForEach-Object {[char]$_})
        Print-Info "Generated PostgreSQL password"
    }
    
    # Build connection URI
    $script:POSTGRESQL_URI = "postgres://$($script:POSTGRESQL_USER):$($script:POSTGRESQL_PASS)@$($script:POSTGRESQL_HOST):$($script:POSTGRESQL_PORT)/$($script:POSTGRESQL_DB)?sslmode=disable"
    
    Print-Info "PostgreSQL URI configured: postgres://$($script:POSTGRESQL_USER):****@$($script:POSTGRESQL_HOST):$($script:POSTGRESQL_PORT)/$($script:POSTGRESQL_DB)"
    Print-Warning "Note: On Windows, you must set up PostgreSQL manually before installation."
    Print-Info "Required PostgreSQL setup:"
    Print-Info "  1. Install PostgreSQL from https://www.postgresql.org/download/windows/"
    Print-Info "  2. Create user: CREATE USER $($script:POSTGRESQL_USER) WITH PASSWORD '...' CREATEDB;"
    Print-Info "  3. Create database: CREATE DATABASE $($script:POSTGRESQL_DB) OWNER $($script:POSTGRESQL_USER);"
    
    return $true
}

function Migrate-SQLiteToPostgreSQL {
    Print-Step "Migrating existing SQLite data to PostgreSQL..."
    
    $sqliteDb = Join-Path $script:RUSTDESK_PATH "db_v2.sqlite3"
    
    if (-not (Test-Path $sqliteDb)) {
        Print-Info "No existing SQLite database found, skipping migration"
        return
    }
    
    # Find migration binary
    $migrateBin = $null
    $migratePaths = @(
        (Join-Path $script:ScriptDir "betterdesk-server\tools\migrate\migrate.exe"),
        (Join-Path $script:ScriptDir "tools\migrate\migrate.exe")
    )
    
    foreach ($path in $migratePaths) {
        if (Test-Path $path) {
            $migrateBin = $path
            break
        }
    }
    
    if (-not $migrateBin) {
        Print-Warning "Migration binary not found, skipping automatic migration"
        Print-Info "You can migrate manually using: M -> 3 (SQLite -> PostgreSQL)"
        return
    }
    
    # Check if SQLite has data
    try {
        $peerCount = & sqlite3 $sqliteDb "SELECT COUNT(*) FROM peer;" 2>$null
    } catch {
        $peerCount = 0
    }
    
    if ($peerCount -gt 0) {
        Print-Info "Found $peerCount devices in SQLite database"
        
        if ($script:AUTO_MODE -or (Confirm-Action "Migrate existing data to PostgreSQL?")) {
            Print-Step "Creating backup before migration..."
            & $migrateBin -mode backup -src $sqliteDb 2>&1 | Out-Null
            
            Print-Step "Running SQLite -> PostgreSQL migration..."
            $result = & $migrateBin -mode nodejs2go -src $sqliteDb -dst $script:POSTGRESQL_URI 2>&1
            if ($LASTEXITCODE -eq 0) {
                Print-Success "Migration completed! $peerCount devices migrated."
            } else {
                Print-Warning "Migration had issues: $result"
            }
        }
    } else {
        Print-Info "SQLite database is empty, no migration needed"
    }
}

function Install-NodeJsConsole {
    Print-Step "Installing Node.js Web Console..."
    
    # Install Node.js if not present
    if (-not (Install-NodeJs)) {
        Print-Error "Cannot proceed without Node.js"
        return $false
    }
    
    # Create directory
    if (-not (Test-Path $script:CONSOLE_PATH)) {
        New-Item -ItemType Directory -Path $script:CONSOLE_PATH -Force | Out-Null
    }
    
    # Check for web-nodejs folder first, then web folder with server.js
    $sourceFolder = $null
    $webNodejsPath = Join-Path $script:ScriptDir "web-nodejs"
    $webPath = Join-Path $script:ScriptDir "web"
    
    if (Test-Path (Join-Path $webNodejsPath "server.js")) {
        $sourceFolder = $webNodejsPath
        Print-Info "Found Node.js console in web-nodejs/"
    } elseif (Test-Path (Join-Path $webPath "server.js")) {
        $sourceFolder = $webPath
        Print-Info "Found Node.js console in web/"
    } else {
        Print-Error "Node.js web console not found!"
        Print-Info "Expected: $webNodejsPath\server.js or $webPath\server.js"
        return $false
    }
    
    # Copy web files (wildcard skips dotfiles — .env.example is required by merge-env.js, #166)
    Copy-Item -Path "$sourceFolder\*" -Destination $script:CONSOLE_PATH -Recurse -Force
    $envExampleSrc = Join-Path $sourceFolder ".env.example"
    if (Test-Path $envExampleSrc) {
        Copy-Item -Path $envExampleSrc -Destination (Join-Path $script:CONSOLE_PATH ".env.example") -Force
    }
    $versionSrc = Join-Path $script:ScriptDir "VERSION"
    if (Test-Path $versionSrc) {
        Copy-Item -Path $versionSrc -Destination (Join-Path $script:CONSOLE_PATH "VERSION") -Force -ErrorAction SilentlyContinue
    }
    
    # Install npm dependencies
    Print-Step "Installing npm dependencies..."
    Push-Location $script:CONSOLE_PATH
    try {
        $npmOutput = npm install --production 2>&1
        $npmOutput | ForEach-Object { Write-Host "[npm] $_" }
        if ($LASTEXITCODE -ne 0) {
            Print-Error "npm install failed (exit code: $LASTEXITCODE)"
            Print-Info "Check npm output above for details"
            Pop-Location
            return $false
        }

        # Best-effort install of node-pty for Server Management terminal (BETA).
        # Optional native module — falls back to pipe spawn if build fails.
        Print-Step "Installing optional node-pty (Server Management terminal - BETA)..."
        $ptyOutput = npm install --no-audit --no-fund --no-save node-pty 2>&1
        if ($LASTEXITCODE -eq 0) {
            Print-Success "node-pty installed (real PTY available)"
        } else {
            Print-Warning "node-pty install failed - Server Management terminal will use pipe fallback"
            $ptyOutput | Select-Object -Last 5 | ForEach-Object { Write-Host "[node-pty] $_" }
        }
        
        # Fresh install only when no existing panel state (issue #158).
        $dataDir = Join-Path $script:CONSOLE_PATH "data"
        if (-not (Test-Path $dataDir)) {
            New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
        }

        $envFile = Join-Path $script:CONSOLE_PATH ".env"
        $authDbPath = Join-Path $dataDir "auth.db"
        $isFresh = (-not (Test-Path $envFile)) -and (-not (Test-Path $authDbPath))

        if ($isFresh) {
            if (Test-Path $authDbPath) {
                Print-Info "Removing old auth database (fresh install)..."
                Remove-Item -Force -Path $authDbPath, "$authDbPath-wal", "$authDbPath-shm" -ErrorAction SilentlyContinue
            }
            if ($env:ADMIN_PASSWORD) {
                Print-Info "Using custom admin password from ADMIN_PASSWORD env var"
            }
            New-Item -ItemType File -Path (Join-Path $dataDir ".force_password_update") -Force | Out-Null
        } else {
            Print-Info "Update mode: preserving auth database and panel passwords"
        }

        if (-not (Merge-ConsoleEnv -FreshInstall:$isFresh)) {
            Pop-Location
            return $false
        }

        $nodejsAdminPassword = $env:ADMIN_PASSWORD
        if (-not $nodejsAdminPassword -and (Test-Path $envFile)) {
            $apLine = Select-String -Path $envFile -Pattern '^DEFAULT_ADMIN_PASSWORD=' -SimpleMatch | Select-Object -First 1
            $nodejsAdminPassword = if ($apLine) { ($apLine.Line -split '=', 2)[1].Trim() } else { "" }
        }

        if ($script:USE_POSTGRESQL) {
            Print-Info "Database: PostgreSQL"
        } else {
            Print-Info "Database: SQLite"
        }

        # Persist credentials only when explicitly requested (fresh install).
        if ($script:STORE_ADMIN_CREDENTIALS -and $isFresh -and $nodejsAdminPassword) {
            $credsFile = Join-Path $dataDir ".admin_credentials"
            $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            @("Admin Username: admin", "Admin Password: $nodejsAdminPassword", "Generated by: BetterDesk installer", "Timestamp: $timestamp") | Out-File -FilePath $credsFile -Encoding UTF8
        }
        
        $script:CONSOLE_TYPE = "nodejs"
        Print-Success "Node.js Web Console installed"
        return $true
    } catch {
        Print-Error "Failed to install npm dependencies: $_"
        return $false
    } finally {
        Pop-Location
    }
}

# Install-FlaskConsole removed in v2.3.0 - Flask support deprecated

function Migrate-Console {
    param(
        [string]$FromType,
        [string]$ToType
    )
    
    Print-Step "Migrating from $FromType to $ToType..."
    
    # Backup existing console
    $backupPath = Join-Path $script:BACKUP_DIR "console_${FromType}_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
    if (-not (Test-Path $backupPath)) {
        New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
    }
    
    # Backup user database (auth.db) if exists
    $authDb = Join-Path $script:CONSOLE_PATH "data\auth.db"
    if (Test-Path $authDb) {
        Copy-Item -Path $authDb -Destination $backupPath
        Print-Info "Backed up user database"
    }
    
    # Backup .env if exists
    $envFile = Join-Path $script:CONSOLE_PATH ".env"
    if (Test-Path $envFile) {
        Copy-Item -Path $envFile -Destination $backupPath
    }
    
    # Stop old console service/task
    Stop-Service -Name $script:CONSOLE_SERVICE -ErrorAction SilentlyContinue -Force
    Stop-ScheduledTask -TaskName $script:CONSOLE_SERVICE -ErrorAction SilentlyContinue
    
    # Remove old console specific files
    $venvPath = Join-Path $script:CONSOLE_PATH "venv"
    $nodeModulesPath = Join-Path $script:CONSOLE_PATH "node_modules"
    if (Test-Path $venvPath) { Remove-Item -Path $venvPath -Recurse -Force }
    if (Test-Path $nodeModulesPath) { Remove-Item -Path $nodeModulesPath -Recurse -Force }
    
    Print-Success "Old $FromType console backed up to $backupPath"
}

function Install-Console {
    # Always install Node.js console (Flask removed in v2.3.0)
    Print-Info "Installing Node.js web console..."
    
    # Check for existing Flask console and migrate
    if (Test-Path $script:CONSOLE_PATH) {
        if ((Test-Path (Join-Path $script:CONSOLE_PATH "app.py")) -and -not (Test-Path (Join-Path $script:CONSOLE_PATH "server.js"))) {
            Print-Warning "Legacy Flask console detected at $($script:CONSOLE_PATH)"
            if (-not $script:AUTO_MODE) {
                if (Confirm-Action "Migrate from Flask to Node.js?") {
                    Migrate-Console -FromType "flask" -ToType "nodejs"
                } else {
                    Print-Info "Flask is deprecated. Installing Node.js alongside..."
                }
            } else {
                Print-Info "Auto mode: Migrating from Flask to Node.js"
                Migrate-Console -FromType "flask" -ToType "nodejs"
            }
        }
    }
    
    return Install-NodeJsConsole
}

function Install-Binaries {
    param(
        [switch]$ForceRecompile
    )
    
    Print-Step "Installing BetterDesk Go Server..."
    
    # Create directory
    if (-not (Test-Path $script:RUSTDESK_PATH)) {
        New-Item -ItemType Directory -Path $script:RUSTDESK_PATH -Force | Out-Null
    }
    
    # Check for Go server binary
    $goBinaryPath = Join-Path $script:GO_SERVER_SOURCE "betterdesk-server.exe"
    $needCompile = $false
    
    if (-not (Test-Path $goBinaryPath)) {
        $needCompile = $true
        Print-Info "Pre-compiled binary not found, attempting to compile..."
    } elseif ($ForceRecompile) {
        # During UPDATE: check if any .go source file is newer than the binary
        $binaryTime = (Get-Item $goBinaryPath).LastWriteTime
        $newerSource = Get-ChildItem -Path $script:GO_SERVER_SOURCE -Filter "*.go" -Recurse |
            Where-Object { $_.LastWriteTime -gt $binaryTime } |
            Select-Object -First 1
        if ($newerSource) {
            $needCompile = $true
            Print-Info "Source code updated since last build, recompiling..."
        } else {
            Print-Info "Binary is up-to-date with source code"
        }
    }
    
    if ($needCompile) {
        # Check if Go is installed
        if (-not (Test-GoInstalled)) {
            Print-Info "Installing Go toolchain..."
            if (-not (Install-Golang)) {
                Print-Error "Failed to install Go toolchain"
                return $false
            }
        }
        
        # Compile Go server
        if (-not (Compile-GoServer)) {
            Print-Error "Failed to compile Go server"
            return $false
        }
    } else {
        Print-Info "Using existing Go server binary"
    }
    
    # Verify binary
    if (-not (Verify-Binaries)) {
        Print-Error "Aborting installation due to verification failure"
        return $false
    }
    
    # Stop services and kill processes (prevents file locking)
    Print-Info "Stopping services before binary installation..."
    Stop-Service -Name $script:SERVER_SERVICE -ErrorAction SilentlyContinue -Force
    Stop-Service -Name $script:HBBS_SERVICE -ErrorAction SilentlyContinue -Force
    Stop-Service -Name $script:HBBR_SERVICE -ErrorAction SilentlyContinue -Force
    Stop-ScheduledTask -TaskName $script:SERVER_SERVICE -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName $script:HBBS_SERVICE -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName $script:HBBR_SERVICE -ErrorAction SilentlyContinue
    
    # Kill any remaining processes
    Get-Process -Name "betterdesk-server" -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process -Name "hbbs" -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process -Name "hbbr" -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    
    # Target path
    $serverTarget = Join-Path $script:RUSTDESK_PATH "betterdesk-server.exe"
    
    # Verify file is not locked
    if (Test-Path $serverTarget) {
        try {
            $stream = [System.IO.File]::Open($serverTarget, 'Open', 'ReadWrite', 'None')
            $stream.Close()
        } catch {
            Print-Warning "File $serverTarget is still locked, waiting..."
            Start-Sleep -Seconds 3
            Get-Process -Name "betterdesk-server" -ErrorAction SilentlyContinue | Stop-Process -Force
        }
    }
    
    # Copy binary
    Copy-Item -Path $goBinaryPath -Destination $serverTarget -Force
    Print-Success "Installed betterdesk-server.exe (Go: signal + relay + API)"
    
    Print-Success "BetterDesk Go Server v$script:VERSION installed"
    return $true
}

function Update-EnvForTLS {
    param(
        [string]$CertPath,
        [string]$KeyPath,
        [bool]$UpdateApiUrls = $false
    )
    $envFile = Join-Path $script:CONSOLE_PATH ".env"
    if (Test-Path $envFile) {
        $content = Get-Content $envFile -Raw
        $content = $content -replace 'HTTPS_ENABLED=.*', 'HTTPS_ENABLED=true'
        $content = $content -replace 'SSL_CERT_PATH=.*', "SSL_CERT_PATH=$CertPath"
        $content = $content -replace 'SSL_KEY_PATH=.*', "SSL_KEY_PATH=$KeyPath"
        # Internal Go API URLs must stay HTTP for RustDesk client compatibility.
        $content = $content -replace 'HBBS_API_URL=https://localhost', 'HBBS_API_URL=http://localhost'
        $content = $content -replace 'BETTERDESK_API_URL=https://localhost', 'BETTERDESK_API_URL=http://localhost'
        if ($content -match 'NODE_EXTRA_CA_CERTS=') {
            $content = $content -replace 'NODE_EXTRA_CA_CERTS=.*', "NODE_EXTRA_CA_CERTS=$CertPath"
        } else {
            $content = $content.TrimEnd() + "`nNODE_EXTRA_CA_CERTS=$CertPath`n"
        }
        Set-Content -Path $envFile -Value $content -NoNewline
        Print-Info "Updated .env with HTTPS configuration"
    }
}

function Generate-SSLCertificates {
    Print-Step "Generating self-signed TLS certificates..."
    
    $sslDir = Join-Path $script:RUSTDESK_PATH "ssl"
    $certPath = Join-Path $sslDir "betterdesk.crt"
    $keyPath = Join-Path $sslDir "betterdesk.key"
    
    # Skip if certificates already exist
    if ((Test-Path $certPath) -and (Test-Path $keyPath)) {
        Print-Info "TLS certificates already exist at $sslDir"
        Print-Info "Skipping certificate generation (use SSL config menu to regenerate)"
        return $true
    }
    
    New-Item -ItemType Directory -Path $sslDir -Force | Out-Null
    
    # Detect server IP for SAN
    $serverIP = Get-PublicIP
    
    # Try PowerShell native certificate generation first
    try {
        $cert = New-SelfSignedCertificate `
            -DnsName "localhost", $serverIP `
            -CertStoreLocation "Cert:\LocalMachine\My" `
            -NotAfter (Get-Date).AddYears(3) `
            -KeyAlgorithm RSA `
            -KeyLength 2048 `
            -FriendlyName "BetterDesk Server" `
            -TextExtension @("2.5.29.17={text}DNS=localhost&IPAddress=$serverIP&IPAddress=127.0.0.1")
        
        # Export certificate (public)
        Export-Certificate -Cert $cert -FilePath "$sslDir\betterdesk.cer" -Type CERT | Out-Null
        
        # Export PFX then convert to PEM using openssl if available
        $pfxPath = Join-Path $sslDir "betterdesk.pfx"
        $securePassword = ConvertTo-SecureString -String "betterdesk-temp" -Force -AsPlainText
        Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePassword | Out-Null
        
        # Check if openssl is available for PEM conversion
        $opensslCmd = Get-Command openssl -ErrorAction SilentlyContinue
        if ($opensslCmd) {
            & openssl pkcs12 -in $pfxPath -out $certPath -clcerts -nokeys -passin "pass:betterdesk-temp" 2>$null
            & openssl pkcs12 -in $pfxPath -out $keyPath -nocerts -nodes -passin "pass:betterdesk-temp" 2>$null
            Remove-Item $pfxPath -Force -ErrorAction SilentlyContinue
        } else {
            # Keep PFX format for Windows (Go server can use it)
            Print-Info "OpenSSL not found - certificate stored as PFX"
            Print-Info "PFX path: $pfxPath"
        }
        
        # Clean up certificate from store
        Remove-Item "Cert:\LocalMachine\My\$($cert.Thumbprint)" -ErrorAction SilentlyContinue
        
        # Enable HTTPS in .env so Node.js console (admin panel port 5000/5443) uses TLS
        Update-EnvForTLS -CertPath $certPath -KeyPath $keyPath
        
        Print-Success "Self-signed TLS certificate generated"
        Print-Info "Certificate: $sslDir"
        Print-Info "SAN: DNS:localhost, IP:$serverIP, IP:127.0.0.1"
        Print-Info "Valid for 3 years"
        return $true
    } catch {
        Print-Warning "PowerShell certificate generation failed: $_"
        
        # Fallback: try openssl if available
        $opensslCmd = Get-Command openssl -ErrorAction SilentlyContinue
        if ($opensslCmd) {
            Print-Info "Falling back to openssl..."
            try {
                & openssl req -x509 -nodes -days 1095 -newkey rsa:2048 `
                    -keyout $keyPath `
                    -out $certPath `
                    -subj "/CN=$serverIP/O=BetterDesk/C=US" `
                    -addext "subjectAltName=IP:$serverIP,IP:127.0.0.1,DNS:localhost" 2>$null
                
                if ((Test-Path $certPath) -and (Test-Path $keyPath)) {
                    Update-EnvForTLS -CertPath $certPath -KeyPath $keyPath
                    Print-Success "Self-signed TLS certificate generated (openssl)"
                    return $true
                }
            } catch {
                Print-Warning "OpenSSL fallback also failed"
            }
        }
        
        Print-Warning "Could not generate TLS certificates automatically"
        Print-Info "Use SSL config menu (option C) to generate later"
        return $false
    }
}

function Set-ServiceLeastPrivilege {
    param(
        [string]$ServiceName,
        [string]$NssmPath,
        [string[]]$Paths
    )
    # Privilege separation: run the NSSM service under its per-service virtual
    # account (NT SERVICE\<service>) instead of the default LocalSystem. Virtual
    # accounts are unprivileged, auto-managed, need no password, and already hold
    # the "Log on as a service" right. Skipped when -RunAsRoot is set.
    if ($script:RUN_AS_ROOT) {
        & $NssmPath set $ServiceName ObjectName "LocalSystem" 2>$null | Out-Null
        return
    }

    $account = "NT SERVICE\$ServiceName"
    & $NssmPath set $ServiceName ObjectName $account "" 2>$null | Out-Null

    foreach ($p in $Paths) {
        if ($p -and (Test-Path $p)) {
            try {
                & icacls "$p" /grant "${account}:(OI)(CI)M" /T /C /Q 2>$null | Out-Null
            } catch {
                Print-Warning "Could not grant $account access to $p"
            }
        }
    }
    Print-Info "Service $ServiceName runs under least-privilege account ($account)"
}

# Safe in-place patch of NSSM services (TLS API flags, HTTP URLs) without remove+install.
function Patch-ServiceDefinitions {
    $nssm = Get-Command nssm -ErrorAction SilentlyContinue
    if (-not $nssm) {
        $nssmLocal = Join-Path $script:ScriptDir "tools\nssm.exe"
        if (Test-Path $nssmLocal) { $nssm = $nssmLocal } else { return }
    }
    $nssmExe = if ($nssm -is [System.Management.Automation.ApplicationInfo]) { $nssm.Source } else { $nssm }

    $changed = $false
    foreach ($svc in @($script:SERVER_SERVICE, $script:CONSOLE_SERVICE)) {
        if (-not (Get-Service -Name $svc -ErrorAction SilentlyContinue)) { continue }
        try {
            if ($svc -eq $script:SERVER_SERVICE) {
                $args = (& $nssmExe get $svc AppParameters 2>$null)
                if ($args) {
                    $clean = ($args -replace '\s-tls-api(=\S+)?', '' -replace '\s-tls-api-port(=\S+)?', '').Trim()
                    if ($clean -ne $args.Trim()) {
                        & $nssmExe set $svc AppParameters $clean | Out-Null
                        Print-Info "Patched $svc AppParameters (removed incompatible TLS API flags)"
                        $changed = $true
                    }
                }
            }
            $envRaw = (& $nssmExe get $svc AppEnvironmentExtra 2>$null)
            if ($envRaw) {
                $cleanEnv = $envRaw `
                    -replace 'HBBS_API_URL=https://localhost', 'HBBS_API_URL=http://localhost' `
                    -replace 'BETTERDESK_API_URL=https://localhost', 'BETTERDESK_API_URL=http://localhost'
                if ($cleanEnv -ne $envRaw) {
                    & $nssmExe set $svc AppEnvironmentExtra $cleanEnv | Out-Null
                    Print-Info "Patched $svc AppEnvironmentExtra (Go API URLs stay HTTP)"
                    $changed = $true
                }
            }
        } catch { }
    }
    if ($changed) {
        Print-Success "Service definitions patched (custom NSSM settings preserved)"
    }
}

# During UPDATE: create missing services; patch existing; optional full recreate.
function Maybe-UpdateServices {
    param(
        [ValidateSet('default', 'recreate')]
        [string]$Mode = 'default'
    )

    $needSetup = $false
    if (-not (Get-Service -Name $script:SERVER_SERVICE -ErrorAction SilentlyContinue)) {
        $needSetup = $true
    }
    if ((Test-Path (Join-Path $script:CONSOLE_PATH "server.js")) -and
        -not (Get-Service -Name $script:CONSOLE_SERVICE -ErrorAction SilentlyContinue)) {
        $needSetup = $true
    }
    if ($needSetup) {
        Print-Info "Services missing — creating Windows services..."
        Setup-Services
        return
    }

    Patch-ServiceDefinitions

    if ($Mode -eq 'recreate' -or $env:UPDATE_REFRESH_SERVICES -eq 'true') {
        Print-Info "Recreating Windows services from template..."
        Setup-Services
        return
    }

    Print-Info "Services present — patched in place (Repair → Repair services for full recreate)"
}

function Setup-Services {
    Print-Step "Configuring Windows services..."
    
    # SAFETY NET: Re-read database config from .env if script vars are empty.
    # This prevents PostgreSQL -> SQLite regression during UPDATE/REPAIR
    # if Preserve-DatabaseConfig was not called or vars were lost.
    if (-not $script:USE_POSTGRESQL) {
        $envFile = Join-Path $script:CONSOLE_PATH ".env"
        if (Test-Path $envFile) {
            $dtLine = Select-String -Path $envFile -Pattern '^DB_TYPE=' -SimpleMatch | Select-Object -First 1
            $_envDbType = if ($dtLine) { ($dtLine.Line -split '=', 2)[1].Trim() } else { "" }
            if ($_envDbType -eq "postgres") {
                $duLine = Select-String -Path $envFile -Pattern '^DATABASE_URL=' -SimpleMatch | Select-Object -First 1
                $_envDbUrl = if ($duLine) { ($duLine.Line -split '=', 2)[1].Trim() } else { "" }
                if ($_envDbUrl) {
                    $script:USE_POSTGRESQL = $true
                    $script:POSTGRESQL_URI = $_envDbUrl
                    Print-Info "Recovered PostgreSQL config from existing .env"
                }
            }
        }
    }
    
    # Resolve relay server IP according to RELAY_MODE / RELAY_SERVERS
    # Interactive relay mode selection (skipped in auto mode or when explicitly set)
    if (-not $script:AUTO_MODE -and -not $script:RELAY_SERVERS -and $script:RELAY_MODE -eq "auto") {
        $localIp = Get-LocalIP
        Write-Host ""
        Print-Info "Relay server address controls how clients connect for remote sessions."
        Write-Host "  1) Internet / public  (auto-detect public IP - default)" -ForegroundColor Cyan
        Write-Host "  2) LAN only           (use this server's local IP: $localIp)" -ForegroundColor Cyan
        Write-Host "  3) Custom address     (enter a specific IP or host)" -ForegroundColor Cyan
        $relayChoice = Read-Host "  Select relay mode [1]"
        switch ($relayChoice) {
            "2" { $script:RELAY_MODE = "local" }
            "3" { $script:RELAY_SERVERS = Read-Host "  Enter relay address (IP or host[:port])" }
            default { $script:RELAY_MODE = "auto" }
        }
        Write-Host ""
    }

    $serverIP = Resolve-RelayIp
    $connModeEnv = Resolve-ConnectionModeEnv

    Print-Info "Relay server IP: $serverIP (mode: $(if ($script:RELAY_SERVERS) { 'fixed' } else { $script:RELAY_MODE }))"
    Print-Info "API Port: $script:API_PORT"
    
    # Build database value (raw). The DSN is passed to the Go server through NSSM
    # AppEnvironmentExtra (DB_URL env var), never as a CLI argument, so the
    # PostgreSQL password does not appear in the process command line.
    $dbValue = ""
    if ($script:USE_POSTGRESQL -and $script:POSTGRESQL_URI) {
        $dbValue = $script:POSTGRESQL_URI
        Print-Info "Database: PostgreSQL"
    } else {
        $dbValue = $script:DB_PATH
        Print-Info "Database: SQLite"
    }
    
    # Check for NSSM (Non-Sucking Service Manager)
    $nssmPath = Get-Command nssm -ErrorAction SilentlyContinue
    
    if (-not $nssmPath) {
        # Try to find NSSM in the project directory
        $nssmLocalPath = Join-Path $script:ScriptDir "tools\nssm.exe"
        if (Test-Path $nssmLocalPath) {
            $nssmPath = $nssmLocalPath
        } else {
            Print-Warning "NSSM not found. Services will be created as scheduled tasks."
            Print-Info "For proper Windows services, install NSSM from https://nssm.cc"
            
            # Create scheduled tasks as fallback
            Setup-ScheduledTasks -ServerIP $serverIP
            return
        }
    }
    
    $nssm = if ($nssmPath -is [System.Management.Automation.ApplicationInfo]) { $nssmPath.Source } else { $nssmPath }
    
    # Remove legacy services
    & $nssm stop $script:HBBS_SERVICE 2>$null
    & $nssm remove $script:HBBS_SERVICE confirm 2>$null
    & $nssm stop $script:HBBR_SERVICE 2>$null
    & $nssm remove $script:HBBR_SERVICE confirm 2>$null
    & $nssm stop $script:SERVER_SERVICE 2>$null
    & $nssm remove $script:SERVER_SERVICE confirm 2>$null
    & $nssm stop $script:CONSOLE_SERVICE 2>$null
    & $nssm remove $script:CONSOLE_SERVICE confirm 2>$null
    
    # Remove legacy Flask API service (deprecated in v2.3.0)
    & $nssm stop "BetterDeskAPI" 2>$null
    & $nssm remove "BetterDeskAPI" confirm 2>$null
    
    Start-Sleep -Seconds 2
    
    # Generate shared API key for Node.js <-> Go server communication
    $apiKeyPath = Join-Path $script:RUSTDESK_PATH ".api_key"
    if (-not (Test-Path $apiKeyPath)) {
        $apiKeyBytes = New-Object byte[] 32
        $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
        $rng.GetBytes($apiKeyBytes)
        $rng.Dispose()
        $apiKey = [System.BitConverter]::ToString($apiKeyBytes) -replace '-', '' | ForEach-Object { $_.ToLower() }
        Set-Content -Path $apiKeyPath -Value $apiKey -NoNewline
        Print-Info "Generated API key for console-server communication"
    }
    
    # BetterDesk Go Server (single binary: signal + relay + API)
    $serverExe = Join-Path $script:RUSTDESK_PATH "betterdesk-server.exe"
    $signalRateLimit = if ($env:SIGNAL_RATE_LIMIT_PER_IP) { $env:SIGNAL_RATE_LIMIT_PER_IP } else { "20" }
    if ($signalRateLimit -notmatch '^\d+$') {
        Print-Warning "Invalid SIGNAL_RATE_LIMIT_PER_IP='$signalRateLimit'; using 20"
        $signalRateLimit = "20"
    }
    $serverArgs = "-mode all -relay-servers $serverIP -key-file `"$script:RUSTDESK_PATH\id_ed25519`" -api-port $script:API_PORT -signal-rate-limit-per-ip $signalRateLimit"
    
    # Discover admin password to sync the Go server initial admin with the
    # Node.js console. It is passed via NSSM AppEnvironmentExtra (INIT_ADMIN_PASS),
    # never as a CLI argument, to keep it out of the process command line.
    $adminPass = $null
    $credsFile = Join-Path $script:CONSOLE_PATH "data\.admin_credentials"
    if (Test-Path $credsFile) {
        $credsContent = Get-Content $credsFile -Raw
        if ($credsContent -match ':(.+)') {
            $adminPass = $Matches[1].Trim()
        }
    }
    if (-not $adminPass) {
        $envFile = Join-Path $script:CONSOLE_PATH ".env"
        if (Test-Path $envFile) {
            $line = Get-Content $envFile | Where-Object { $_ -like 'DEFAULT_ADMIN_PASSWORD=*' } | Select-Object -First 1
            if ($line) {
                $adminPass = ($line -split '=', 2)[1].Trim()
            }
        }
    }
    
    # Add TLS flags if certificates exist
    $sslDir = Join-Path $script:RUSTDESK_PATH "ssl"
    $certPath = Join-Path $sslDir "betterdesk.crt"
    $keyPath = Join-Path $sslDir "betterdesk.key"
    $apiScheme = "http"
    $tlsIsSelfSigned = $false
    if ((Test-Path $certPath) -and (Test-Path $keyPath)) {
        # Check if certificate is self-signed
        try {
            $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certPath)
            $tlsIsSelfSigned = ($cert.Issuer -eq $cert.Subject) -or ($cert.Subject -like "*O=BetterDesk*")
            $cert.Dispose()
        } catch {
            $tlsIsSelfSigned = $true
        }
        
        # Enable TLS on signal/relay for client encryption.
        # API port (21121) MUST stay HTTP -- RustDesk desktop clients always send
        # plain HTTP to signal_port-2 and do not support HTTPS for API endpoints.
        $serverArgs += " -tls-cert `"$certPath`" -tls-key `"$keyPath`" -tls-signal -tls-relay"
        
        # RustDesk clients always send HTTP to API port. API stays HTTP for all cert types.
        if (-not $tlsIsSelfSigned) {
            $apiScheme = "http"
            Print-Info "TLS: Enabled for signal/relay (proper certificate, API stays HTTP)"
        } else {
            $apiScheme = "http"
            Print-Info "TLS: Enabled for signal/relay (self-signed cert, API stays HTTP)"
        }
    } else {
        Print-Info "TLS: Disabled (no certificate found)"
    }
    
    & $nssm install $script:SERVER_SERVICE $serverExe $serverArgs
    & $nssm set $script:SERVER_SERVICE AppDirectory $script:RUSTDESK_PATH
    & $nssm set $script:SERVER_SERVICE DisplayName "BetterDesk Go Server v$script:VERSION"
    & $nssm set $script:SERVER_SERVICE Description "BetterDesk Go Server (Signal + Relay + API)"
    & $nssm set $script:SERVER_SERVICE Start SERVICE_AUTO_START
    & $nssm set $script:SERVER_SERVICE AppStdout "$script:RUSTDESK_PATH\logs\server.log"
    & $nssm set $script:SERVER_SERVICE AppStderr "$script:RUSTDESK_PATH\logs\server_error.log"
    
    # Server secrets via environment (DB_URL / INIT_ADMIN_PASS) instead of CLI
    # arguments, so the PostgreSQL and admin passwords stay out of the process
    # command line (NSSM stores these in the ACL-protected service registry key).
    $serverEnvExtra = @("DB_URL=$dbValue")
    if ($adminPass) { $serverEnvExtra += "INIT_ADMIN_PASS=$adminPass" }
    if ($connModeEnv) { $serverEnvExtra += $connModeEnv }
    # New installs default to "managed" enrollment so stock RustDesk clients are
    # queued for operator approval. Existing installs are left untouched.
    if ($script:FRESH_INSTALL) { $serverEnvExtra += "ENROLLMENT_MODE=managed" }
    $serverEnvExtra += "MESH_ENABLED=Y"
    & $nssm set $script:SERVER_SERVICE AppEnvironmentExtra $serverEnvExtra
    
    # Privilege separation: drop the Go server to its low-privilege virtual account.
    Set-ServiceLeastPrivilege -ServiceName $script:SERVER_SERVICE -NssmPath $nssm -Paths @($script:RUSTDESK_PATH)
    
    Print-Success "Created BetterDesk Go Server service"
    
    # Console Service (Web Interface) - Node.js only
    if ($script:CONSOLE_TYPE -eq "nodejs") {
        $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $nodeExe) { $nodeExe = "node.exe" }
        $serverJs = Join-Path $script:CONSOLE_PATH "server.js"
        
        & $nssm install $script:CONSOLE_SERVICE $nodeExe $serverJs
        & $nssm set $script:CONSOLE_SERVICE AppDirectory $script:CONSOLE_PATH
        & $nssm set $script:CONSOLE_SERVICE DisplayName "BetterDesk Web Console (Node.js)"
        & $nssm set $script:CONSOLE_SERVICE Description "BetterDesk Web Management Console - Node.js"
        & $nssm set $script:CONSOLE_SERVICE Start SERVICE_AUTO_START
        $envExtra = @(
            "NODE_ENV=production",
            "RUSTDESK_DIR=$script:RUSTDESK_PATH",
            "RUSTDESK_PATH=$script:RUSTDESK_PATH",
            "KEYS_PATH=$script:RUSTDESK_PATH",
            "DATA_DIR=$script:CONSOLE_PATH\data",
            "DB_PATH=$script:RUSTDESK_PATH\db_v2.sqlite3",
            "PUB_KEY_PATH=$script:RUSTDESK_PATH\id_ed25519.pub",
            "API_KEY_PATH=$script:RUSTDESK_PATH\.api_key",
            "HBBS_API_URL=${apiScheme}://localhost:$($script:API_PORT)/api",
            "BETTERDESK_API_URL=${apiScheme}://localhost:$($script:API_PORT)/api",
            "SERVER_BACKEND=betterdesk",
            "PORT=5000",
            "HOST=0.0.0.0",
            "API_HOST=0.0.0.0"
        )
        # Propagate database type to NSSM environment
        if ($script:USE_POSTGRESQL -and $script:POSTGRESQL_URI) {
            $envExtra += "DB_TYPE=postgres"
            $envExtra += "DATABASE_URL=$($script:POSTGRESQL_URI)"
        } else {
            $envExtra += "DB_TYPE=sqlite"
        }
        # Enable HTTPS on Node.js console when TLS certs are available (for browser access)
        # This is separate from Go API TLS -- the web panel can serve HTTPS for browsers
        if ((Test-Path $certPath) -and (Test-Path $keyPath)) {
            $envExtra += "HTTPS_ENABLED=true"
            $envExtra += "SSL_CERT_PATH=$certPath"
            $envExtra += "SSL_KEY_PATH=$keyPath"
            $envExtra += "RUSTDESK_API_TLS=$(if ($tlsIsSelfSigned) { 'false' } else { 'auto' })"
        }
        # Trust self-signed cert for localhost API communication
        if ($tlsIsSelfSigned -and (Test-Path $certPath)) {
            $envExtra += "NODE_EXTRA_CA_CERTS=$certPath"
        }
        & $nssm set $script:CONSOLE_SERVICE AppEnvironmentExtra $envExtra
        & $nssm set $script:CONSOLE_SERVICE AppStdout "$script:CONSOLE_PATH\logs\console.log"
        & $nssm set $script:CONSOLE_SERVICE AppStderr "$script:CONSOLE_PATH\logs\console_error.log"
        
        # Privilege separation: the console's virtual account needs read/write on
        # its own dir and read access to the server keys / API key in RUSTDESK_PATH.
        Set-ServiceLeastPrivilege -ServiceName $script:CONSOLE_SERVICE -NssmPath $nssm -Paths @($script:CONSOLE_PATH, $script:RUSTDESK_PATH)
        
        Print-Success "Created Node.js console service"
    }
    
    # Create logs directories
    New-Item -ItemType Directory -Path "$script:RUSTDESK_PATH\logs" -Force | Out-Null
    New-Item -ItemType Directory -Path "$script:CONSOLE_PATH\logs" -Force | Out-Null
    
    Print-Success "Windows services configured"
    Print-Info "Services: $script:SERVER_SERVICE, $script:CONSOLE_SERVICE"
}

function Get-GoBillingEnvLauncherLines {
    param([string]$EnvFilePath)
    $lines = @()
    $keys = @(
        'NTP_SERVERS',
        'BILLING_MAX_CLOCK_SKEW_MS',
        'BILLING_REQUIRE_SYNCED_CLOCK',
        'BILLING_TRUST_OS_NTP'
    )
    if (-not $EnvFilePath -or -not (Test-Path $EnvFilePath)) {
        return $lines
    }
    foreach ($rawLine in Get-Content $EnvFilePath) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $parts = $line -split '=', 2
        if ($parts.Count -lt 2) { continue }
        $key = $parts[0].Trim()
        if ($keys -notcontains $key) { continue }
        $value = $parts[1].Trim()
        $lines += "set `"$key=$value`""
    }
    return $lines
}

function Setup-ScheduledTasks {
    param([string]$ServerIP)
    
    Print-Step "Creating scheduled tasks as service alternative..."
    
    # Build database value (raw). Injected into the launcher below as an env var,
    # never as a task action argument (those are visible in Task Scheduler).
    $dbValue = ""
    if ($script:USE_POSTGRESQL -and $script:POSTGRESQL_URI) {
        $dbValue = $script:POSTGRESQL_URI
    } else {
        $dbValue = $script:DB_PATH
    }
    
    # Remove existing tasks
    Unregister-ScheduledTask -TaskName $script:SERVER_SERVICE -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $script:HBBS_SERVICE -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $script:HBBR_SERVICE -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $script:CONSOLE_SERVICE -Confirm:$false -ErrorAction SilentlyContinue
    
    # BetterDesk Go Server Task
    $serverExe = Join-Path $script:RUSTDESK_PATH "betterdesk-server.exe"
    $signalRateLimit = if ($env:SIGNAL_RATE_LIMIT_PER_IP) { $env:SIGNAL_RATE_LIMIT_PER_IP } else { "20" }
    if ($signalRateLimit -notmatch '^\d+$') {
        Print-Warning "Invalid SIGNAL_RATE_LIMIT_PER_IP='$signalRateLimit'; using 20"
        $signalRateLimit = "20"
    }
    $serverArgs = "-mode all -relay-servers $ServerIP -key-file `"$script:RUSTDESK_PATH\id_ed25519`" -api-port $script:API_PORT -signal-rate-limit-per-ip $signalRateLimit"
    
    # Discover admin password (synced with Node.js console). Injected via the
    # protected launcher as INIT_ADMIN_PASS, never as a task action argument.
    $adminPass = $null
    $credsFile = Join-Path $script:CONSOLE_PATH "data\.admin_credentials"
    if (Test-Path $credsFile) {
        $credsContent = Get-Content $credsFile -Raw
        if ($credsContent -match ':(.+)') {
            $adminPass = $Matches[1].Trim()
        }
    }
    if (-not $adminPass) {
        $envFile = Join-Path $script:CONSOLE_PATH ".env"
        if (Test-Path $envFile) {
            $line = Get-Content $envFile | Where-Object { $_ -like 'DEFAULT_ADMIN_PASSWORD=*' } | Select-Object -First 1
            if ($line) {
                $adminPass = ($line -split '=', 2)[1].Trim()
            }
        }
    }
    
    # Add TLS flags if certificates exist
    $sslDir = Join-Path $script:RUSTDESK_PATH "ssl"
    $certPath = Join-Path $sslDir "betterdesk.crt"
    $keyPath = Join-Path $sslDir "betterdesk.key"
    $tlsIsSelfSigned = $false
    if ((Test-Path $certPath) -and (Test-Path $keyPath)) {
        try {
            $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certPath)
            $tlsIsSelfSigned = ($cert.Issuer -eq $cert.Subject) -or ($cert.Subject -like "*O=BetterDesk*")
            $cert.Dispose()
        } catch {
            $tlsIsSelfSigned = $true
        }
        
        $serverArgs += " -tls-cert `"$certPath`" -tls-key `"$keyPath`" -tls-signal -tls-relay"
        if (-not $tlsIsSelfSigned) {
            Print-Info "TLS: Enabled for signal/relay (proper certificate, API stays HTTP)"
        } else {
            Print-Info "TLS: Enabled for signal/relay (self-signed, API stays HTTP)"
        }
    }
    
    # Secrets (DB_URL / INIT_ADMIN_PASS) are injected via a launcher script that
    # is restricted to Administrators/SYSTEM, never via the task action arguments
    # (which are visible in Task Scheduler and the process command line).
    $serverLauncher = Join-Path $script:RUSTDESK_PATH "start-betterdesk-server.cmd"
    $launcherLines = @("@echo off")
    $launcherLines += "set `"DB_URL=$dbValue`""
    if ($adminPass) { $launcherLines += "set `"INIT_ADMIN_PASS=$adminPass`"" }
    # New installs default to "managed" enrollment; existing installs untouched.
    if ($script:FRESH_INSTALL) { $launcherLines += "set `"ENROLLMENT_MODE=managed`"" }
    $billingEnvFile = Join-Path $script:CONSOLE_PATH ".env"
    foreach ($billingLine in (Get-GoBillingEnvLauncherLines -EnvFilePath $billingEnvFile)) {
        $launcherLines += $billingLine
    }
    $launcherLines += "`"$serverExe`" $serverArgs"
    Set-Content -Path $serverLauncher -Value $launcherLines -Encoding ASCII
    & icacls $serverLauncher /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" 2>$null | Out-Null
    $serverAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$serverLauncher`"" -WorkingDirectory $script:RUSTDESK_PATH
    $serverTrigger = New-ScheduledTaskTrigger -AtStartup
    $serverPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $serverSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $script:SERVER_SERVICE -Action $serverAction -Trigger $serverTrigger -Principal $serverPrincipal -Settings $serverSettings -Description "BetterDesk Go Server (Signal + Relay + API)" | Out-Null
    
    # Console Task - Node.js
    if ($script:CONSOLE_TYPE -eq "nodejs") {
        $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $nodeExe) { $nodeExe = "node.exe" }
        $serverJs = Join-Path $script:CONSOLE_PATH "server.js"
        $consoleAction = New-ScheduledTaskAction -Execute $nodeExe -Argument $serverJs -WorkingDirectory $script:CONSOLE_PATH
        $consoleDesc = "BetterDesk Web Console (Node.js)"
        Print-Info "Creating Node.js console task"
    }
    
    $consoleTrigger = New-ScheduledTaskTrigger -AtStartup
    $consolePrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $consoleSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $script:CONSOLE_SERVICE -Action $consoleAction -Trigger $consoleTrigger -Principal $consolePrincipal -Settings $consoleSettings -Description $consoleDesc | Out-Null
    
    Print-Success "Scheduled tasks created"
}

function Run-Migrations {
    Print-Step "Running database migrations..."
    
    # Ensure database directory exists
    $dbDir = Split-Path -Parent $script:DB_PATH
    if (-not (Test-Path $dbDir)) {
        New-Item -ItemType Directory -Path $dbDir -Force | Out-Null
    }
    
    # Create database schema and add missing columns
    $pythonScript = @"
import sqlite3
import os
from datetime import datetime

db_path = r'$($script:DB_PATH)'

# Ensure db directory exists
os.makedirs(os.path.dirname(db_path), exist_ok=True)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Create peer table if not exists
cursor.execute('''
    CREATE TABLE IF NOT EXISTS peer (
        guid BLOB PRIMARY KEY NOT NULL,
        id VARCHAR(100) NOT NULL,
        uuid BLOB NOT NULL,
        pk BLOB NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        user BLOB,
        status INTEGER DEFAULT 0,
        note VARCHAR(300),
        info TEXT NOT NULL,
        last_online TEXT,
        is_deleted INTEGER DEFAULT 0,
        deleted_at TEXT,
        updated_at TEXT,
        previous_ids TEXT,
        id_changed_at TEXT,
        is_banned INTEGER DEFAULT 0
    )
''')

# Create indexes
cursor.execute('CREATE UNIQUE INDEX IF NOT EXISTS index_peer_id ON peer (id)')
cursor.execute('CREATE INDEX IF NOT EXISTS index_peer_user ON peer (user)')
cursor.execute('CREATE INDEX IF NOT EXISTS index_peer_created_at ON peer (created_at)')
cursor.execute('CREATE INDEX IF NOT EXISTS index_peer_status ON peer (status)')

# Create users table
cursor.execute('''
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'viewer',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME,
        is_active INTEGER NOT NULL DEFAULT 1
    )
''')

# Create sessions table
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

# Create audit_log table
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

# Create indexes for auth tables
cursor.execute('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)')
cursor.execute('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)')
cursor.execute('CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id)')
cursor.execute('CREATE INDEX IF NOT EXISTS idx_audit_device ON audit_log(device_id)')
cursor.execute('CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)')

# Add missing columns to peer table
columns_to_add = [
    ('status', 'INTEGER DEFAULT 0'),
    ('last_online', 'TEXT'),
    ('is_deleted', 'INTEGER DEFAULT 0'),
    ('deleted_at', 'TEXT'),
    ('updated_at', 'TEXT'),
    ('note', 'TEXT'),
    ('previous_ids', 'TEXT'),
    ('id_changed_at', 'TEXT'),
    ('is_banned', 'INTEGER DEFAULT 0'),
]

cursor.execute("PRAGMA table_info(peer)")
existing_columns = [col[1] for col in cursor.fetchall()]

for col_name, col_def in columns_to_add:
    if col_name not in existing_columns:
        try:
            cursor.execute(f"ALTER TABLE peer ADD COLUMN {col_name} {col_def}")
            print(f"  Added column: {col_name}")
        except Exception as e:
            pass

conn.commit()
conn.close()
print("Database migrations completed")
"@
    
    $pythonScript | python
    
    Print-Success "Migrations completed"
}

function Create-AdminUser {
    Print-Step "Creating admin user..."
    
    # Detect console type
    $currentConsoleType = ""
    if (Test-Path (Join-Path $script:CONSOLE_PATH "server.js")) {
        $currentConsoleType = "nodejs"
    } elseif (Test-Path (Join-Path $script:CONSOLE_PATH "app.py")) {
        $currentConsoleType = "nodejs"  # Legacy Flask detected, treat as Node.js
        Print-Warning "Legacy Flask console detected. Please migrate to Node.js."
    } else {
        Print-Warning "No console detected, skipping admin creation"
        return $null
    }
    
    # Node.js console - admin is created automatically on startup.
    # Prefer plaintext credentials file (legacy), then .env fallback.
    $adminPassword = $null
    $dataDir = Join-Path $script:CONSOLE_PATH "data"
    $credsFile = Join-Path $dataDir ".admin_credentials"
    if (Test-Path $credsFile) {
        $creds = Get-Content $credsFile -Raw
        $adminPassword = ($creds -split ':')[1].Trim()
    }
    if (-not $adminPassword) {
        $envFile = Join-Path $script:CONSOLE_PATH ".env"
        if (Test-Path $envFile) {
            $line = Get-Content $envFile | Where-Object { $_ -like 'DEFAULT_ADMIN_PASSWORD=*' } | Select-Object -First 1
            if ($line) {
                $adminPassword = ($line -split '=', 2)[1].Trim()
            }
        }
    }

    if ($adminPassword) {
        
        Write-Host ""
        Write-Host "============================================================" -ForegroundColor Green
        Write-Host "             PANEL LOGIN CREDENTIALS                        " -ForegroundColor Green
        Write-Host "============================================================" -ForegroundColor Green
        Write-Host "  Login:    " -NoNewline; Write-Host "admin" -ForegroundColor White
        Write-Host "  Password: " -NoNewline; Write-Host $adminPassword -ForegroundColor White
        Write-Host "============================================================" -ForegroundColor Green
        Write-Host ""
        
        if ($script:STORE_ADMIN_CREDENTIALS) {
            # Legacy behavior (opt-in): persist plaintext credentials file
            $mainCredsFile = Join-Path $script:RUSTDESK_PATH ".admin_credentials"
            "admin:$adminPassword" | Out-File -FilePath $mainCredsFile -Encoding UTF8
            Print-Info "Credentials saved in: $mainCredsFile"
        } else {
            Print-Warning "Credentials are not persisted by default (security hardening)."
        }
        return $adminPassword
    } else {
        Print-Warning "No Node.js admin credentials found"
        Print-Info "Use password reset option to set a new admin password"
        return $null
    }
}

function Start-Services {
    Print-Step "Starting services..."
    
    # Try Go server service first, then legacy
    $goServiceExists = Get-Service -Name $script:SERVER_SERVICE -ErrorAction SilentlyContinue
    $legacyServiceExists = Get-Service -Name $script:HBBS_SERVICE -ErrorAction SilentlyContinue
    
    if ($goServiceExists) {
        # New Go single-binary architecture
        Start-Service -Name $script:SERVER_SERVICE -ErrorAction SilentlyContinue
        Start-Service -Name $script:CONSOLE_SERVICE -ErrorAction SilentlyContinue
    } elseif ($legacyServiceExists) {
        # Legacy Rust architecture (hbbs + hbbr)
        Start-Service -Name $script:HBBS_SERVICE -ErrorAction SilentlyContinue
        Start-Service -Name $script:HBBR_SERVICE -ErrorAction SilentlyContinue
        Start-Service -Name $script:CONSOLE_SERVICE -ErrorAction SilentlyContinue
    } else {
        # Try scheduled tasks (Go first, then legacy)
        $goTaskExists = Get-ScheduledTask -TaskName $script:SERVER_SERVICE -ErrorAction SilentlyContinue
        if ($goTaskExists) {
            Start-ScheduledTask -TaskName $script:SERVER_SERVICE -ErrorAction SilentlyContinue
        } else {
            Start-ScheduledTask -TaskName $script:HBBS_SERVICE -ErrorAction SilentlyContinue
            Start-ScheduledTask -TaskName $script:HBBR_SERVICE -ErrorAction SilentlyContinue
        }
        Start-ScheduledTask -TaskName $script:CONSOLE_SERVICE -ErrorAction SilentlyContinue
    }
    
    Start-Sleep -Seconds 3
    
    Detect-Installation
    
    if ($script:SERVER_RUNNING -or ($script:HBBS_RUNNING -and $script:HBBR_RUNNING)) {
        Print-Success "All services started"
    } else {
        Print-Warning "Some services may not be working properly"
        Print-Info "Check logs in: $script:RUSTDESK_PATH\logs\"
    }
}

function Stop-AllServices {
    Print-Step "Stopping services..."
    
    # Stop Windows services (Go server + legacy)
    Stop-Service -Name $script:SERVER_SERVICE -ErrorAction SilentlyContinue -Force
    Stop-Service -Name $script:HBBS_SERVICE -ErrorAction SilentlyContinue -Force
    Stop-Service -Name $script:HBBR_SERVICE -ErrorAction SilentlyContinue -Force
    Stop-Service -Name $script:CONSOLE_SERVICE -ErrorAction SilentlyContinue -Force
    
    # Stop scheduled tasks
    Stop-ScheduledTask -TaskName $script:SERVER_SERVICE -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName $script:HBBS_SERVICE -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName $script:HBBR_SERVICE -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName $script:CONSOLE_SERVICE -ErrorAction SilentlyContinue
    
    # Kill processes directly (Go server + legacy)
    Get-Process -Name "betterdesk-server" -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process -Name "hbbs" -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process -Name "hbbr" -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
        $_.MainModule.FileName -like "*betterdesk*" -or $_.CommandLine -like "*server.js*"
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    
    Start-Sleep -Seconds 2
}

#===============================================================================
# Enhanced Service Management Functions (v2.1.2)
#===============================================================================

function Test-PortAvailable {
    param([int]$Port, [string]$ServiceName = "unknown")
    
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    
    if ($listener) {
        $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
        Print-Error "Port $Port is in use by: $($process.Name) (PID: $($listener.OwningProcess))"
        return $false
    }
    return $true
}

function Test-ServiceHealth {
    param(
        [string]$ServiceName,
        [int]$ExpectedPort = 0,
        [int]$TimeoutSeconds = 10
    )
    
    # Check if process is running
    $processName = if ($ServiceName -eq $script:SERVER_SERVICE) { "betterdesk-server" }
                   elseif ($ServiceName -match "Signal") { "hbbs" }
                   elseif ($ServiceName -match "Relay") { "hbbr" }
                   elseif ($ServiceName -eq $script:CONSOLE_SERVICE) { "node" }
                   else { "betterdesk-server" }
    
    $process = Get-Process -Name $processName -ErrorAction SilentlyContinue
    
    if (-not $process) {
        Print-Error "Process $processName is not running"
        return $false
    }
    
    # Check port if specified
    if ($ExpectedPort -gt 0) {
        $elapsed = 0
        while ($elapsed -lt $TimeoutSeconds) {
            $listener = Get-NetTCPConnection -LocalPort $ExpectedPort -State Listen -ErrorAction SilentlyContinue
            if ($listener) {
                return $true
            }
            Start-Sleep -Seconds 1
            $elapsed++
        }
        Print-Error "Service not listening on port $ExpectedPort after ${TimeoutSeconds}s"
        return $false
    }
    
    return $true
}

function Start-ServicesWithVerification {
    Print-Step "Starting services with health verification..."
    
    $hasErrors = $false
    
    # Check ports first
    if (-not (Test-PortAvailable -Port 21116 -ServiceName "betterdesk-server")) {
        Print-Error "Port 21116 (ID server) not available"
        $hasErrors = $true
    }
    
    if (-not (Test-PortAvailable -Port 21117 -ServiceName "betterdesk-server")) {
        Print-Error "Port 21117 (relay) not available"  
        $hasErrors = $true
    }
    
    if ($hasErrors) {
        Print-Error "Cannot start services - ports in use"
        Print-Info "Use: Get-NetTCPConnection -State Listen | Where-Object LocalPort -in 21116,21117"
        return $false
    }
    
    # Start Go Server (single binary: signal + relay + API)
    Print-Info "Starting $($script:SERVER_SERVICE) (Go server)..."
    $goServiceExists = Get-Service -Name $script:SERVER_SERVICE -ErrorAction SilentlyContinue
    
    if ($goServiceExists) {
        Start-Service -Name $script:SERVER_SERVICE -ErrorAction SilentlyContinue
    } else {
        # Try scheduled task
        $goTaskExists = Get-ScheduledTask -TaskName $script:SERVER_SERVICE -ErrorAction SilentlyContinue
        if ($goTaskExists) {
            Start-ScheduledTask -TaskName $script:SERVER_SERVICE -ErrorAction SilentlyContinue
        } else {
            # Legacy fallback: start hbbs + hbbr separately
            Print-Warning "Go server service not found, trying legacy hbbs/hbbr..."
            $legacyService = Get-Service -Name $script:HBBS_SERVICE -ErrorAction SilentlyContinue
            if ($legacyService) {
                Start-Service -Name $script:HBBS_SERVICE -ErrorAction SilentlyContinue
                Start-Service -Name $script:HBBR_SERVICE -ErrorAction SilentlyContinue
            } else {
                Start-ScheduledTask -TaskName $script:HBBS_SERVICE -ErrorAction SilentlyContinue
                Start-ScheduledTask -TaskName $script:HBBR_SERVICE -ErrorAction SilentlyContinue
            }
        }
    }
    
    Start-Sleep -Seconds 3
    
    if (-not (Test-ServiceHealth -ServiceName $script:SERVER_SERVICE -ExpectedPort 21116 -TimeoutSeconds 10)) {
        Print-Error "Failed to start BetterDesk server"
        return $false
    }
    Print-Success "BetterDesk server started and healthy (signal + relay + API)"
    
    # Inject shared API key into Go server database for Node.js <-> Go communication
    $apiKeyPath = Join-Path $script:RUSTDESK_PATH ".api_key"
    $goDbPath = Join-Path $script:RUSTDESK_PATH "db_v2.sqlite3"
    if ((Test-Path $apiKeyPath) -and (Test-Path $goDbPath)) {
        $apiKey = Get-Content $apiKeyPath -Raw
        $apiKey = $apiKey.Trim()
        try {
            $env:BETTERDESK_GO_DB_PATH = $goDbPath
            $env:BETTERDESK_API_KEY_TMP = $apiKey
            $pythonScript = "import os, sqlite3; conn = sqlite3.connect(os.environ['BETTERDESK_GO_DB_PATH']); conn.execute('INSERT OR REPLACE INTO server_config (key, value) VALUES (?, ?)', ('api_key', os.environ['BETTERDESK_API_KEY_TMP'])); conn.commit(); conn.close()"
            python -c $pythonScript 2>$null
            Remove-Item Env:BETTERDESK_GO_DB_PATH -ErrorAction SilentlyContinue
            Remove-Item Env:BETTERDESK_API_KEY_TMP -ErrorAction SilentlyContinue
            if ($LASTEXITCODE -eq 0) {
                Print-Info "API key synced to Go server database"
            }
        } catch {
            # Non-critical: API key sync failed, Node.js will still work with JWT auth
        }
    }
    
    # Start Console
    Print-Info "Starting $($script:CONSOLE_SERVICE)..."
    $consoleService = Get-Service -Name $script:CONSOLE_SERVICE -ErrorAction SilentlyContinue
    if ($consoleService) {
        Start-Service -Name $script:CONSOLE_SERVICE -ErrorAction SilentlyContinue
    } else {
        Start-ScheduledTask -TaskName $script:CONSOLE_SERVICE -ErrorAction SilentlyContinue
    }
    
    Start-Sleep -Seconds 2
    Print-Success "All services started and verified"
    
    return $true
}

#=============================================================================
# Minimal Installation Function (Go server only, no web console)
#===============================================================================

function Do-InstallMinimal {
    Print-Header
    Write-Host "========== MINIMAL INSTALLATION (Server Only) ==========" -ForegroundColor White
    Write-Host ""
    
    Print-Info "BetterDesk Minimal installs the Go server binary only."
    Print-Info "No web console, no Node.js, no npm dependencies."
    Print-Info "Manage via REST API on port $script:API_PORT or TCP admin console."
    Write-Host ""
    
    Detect-Installation
    
    if ($script:INSTALL_STATUS -eq "complete") {
        Print-Warning "BetterDesk is already installed!"
        if (-not $script:AUTO_MODE) {
            if (-not (Confirm-Action "Do you want to reinstall in Minimal mode?")) {
                return
            }
        }
        Do-BackupSilent
    }
    
    # Choose database type (SQLite or PostgreSQL)
    Choose-DatabaseType
    
    # Gracefully stop existing services
    Graceful-StopServices
    
    # Create installation directory
    $installDir = $script:INSTALL_DIR
    if (-not (Test-Path $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }
    
    # Setup PostgreSQL if selected
    if ($script:USE_POSTGRESQL) {
        if (-not (Setup-PostgreSQLDatabase)) {
            Print-Error "PostgreSQL setup failed"
            return
        }
    }
    
    # Install Go server binary
    Detect-Architecture
    if (-not (Install-Binaries)) {
        Print-Error "Binary installation failed"
        return
    }
    
    # Skip console installation entirely
    Print-Info "Skipping web console (Minimal mode)"
    
    # Generate self-signed TLS certificates
    Generate-SSLCertificates
    
    # Setup only the Go server service (no console service)
    Setup-ServicesMinimal
    
    # Configure firewall rules (server ports only)
    Print-Step "Configuring firewall rules..."
    $ports = @([int]$script:GO_API_PORT, 21115, 21116, 21117, 21118, 21119)
    foreach ($port in $ports) {
        try {
            New-NetFirewallRule -DisplayName "BetterDesk Port $port" -Direction Inbound -LocalPort $port -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null
        } catch {}
    }
    # UDP for signal port
    try {
        New-NetFirewallRule -DisplayName "BetterDesk Signal UDP 21116" -Direction Inbound -LocalPort 21116 -Protocol UDP -Action Allow -ErrorAction SilentlyContinue | Out-Null
    } catch {}
    
    # Start server
    Print-Step "Starting BetterDesk server..."
    $svcName = "BetterDeskServer"
    if (Get-Service $svcName -ErrorAction SilentlyContinue) {
        Start-Service $svcName -ErrorAction SilentlyContinue
    } elseif (Get-Command nssm -ErrorAction SilentlyContinue) {
        nssm start $svcName 2>$null
    }
    
    Start-Sleep -Seconds 3
    
    # Verify
    $svc = Get-Service $svcName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq "Running") {
        Print-Success "BetterDesk server is running"
    } else {
        Print-Warning "BetterDesk server may not have started correctly"
    }
    
    Write-Host ""
    Print-Success "===== BETTERDESK MINIMAL INSTALLATION COMPLETE ====="
    Write-Host ""
    
    $serverIP = Get-PublicIP
    Write-Host "Server: $serverIP" -ForegroundColor Green
    Write-Host "API: http://${serverIP}:$($script:API_PORT)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Ports: $($script:API_PORT) (API), 21115-21117 (Signal/Relay), 21118-21119 (WS)" -ForegroundColor Yellow
    Write-Host "No web console installed. Use REST API or TCP admin for management." -ForegroundColor Yellow
    Write-Host ""
    
    Press-Enter
}

function Setup-ServicesMinimal {
    Print-Step "Setting up BetterDesk server service (Minimal mode)..."
    
    $goBinary = Join-Path $script:INSTALL_DIR "betterdesk-server.exe"
    $keyDir = $script:INSTALL_DIR
    $dbDir = $script:INSTALL_DIR
    
    # Build arguments
    $serverArgs = "-key `"$keyDir`" -db `"$dbDir`""
    
    # Add relay servers (honors RELAY_MODE / RelayServers)
    $serverIP = Resolve-RelayIp
    if ($serverIP) {
        $serverArgs += " -relay-servers $serverIP"
    }
    
    # TLS configuration
    $tlsCert = Join-Path $script:INSTALL_DIR "cert.pem"
    $tlsKey = Join-Path $script:INSTALL_DIR "key.pem"
    if ((Test-Path $tlsCert) -and (Test-Path $tlsKey)) {
        $serverArgs += " -tls-cert `"$tlsCert`" -tls-key `"$tlsKey`" -tls-signal -tls-relay"
    }
    
    # Remove old services
    foreach ($oldSvc in @("RustDeskSignal", "RustDeskRelay", "BetterDeskAPI", "BetterDeskGo", "BetterDeskConsole")) {
        if (Get-Service $oldSvc -ErrorAction SilentlyContinue) {
            Stop-Service $oldSvc -Force -ErrorAction SilentlyContinue
            if (Get-Command nssm -ErrorAction SilentlyContinue) {
                nssm remove $oldSvc confirm 2>$null
            } else {
                sc.exe delete $oldSvc 2>$null
            }
        }
    }
    
    # Install NSSM if not present
    if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
        Install-NSSM
    }
    
    # Create server service via NSSM
    $svcName = "BetterDeskServer"
    if (Get-Service $svcName -ErrorAction SilentlyContinue) {
        nssm remove $svcName confirm 2>$null
    }
    
    nssm install $svcName $goBinary $serverArgs
    nssm set $svcName AppDirectory $script:INSTALL_DIR
    nssm set $svcName DisplayName "BetterDesk Server (Minimal)"
    nssm set $svcName Description "BetterDesk Go server - signal, relay, and API"
    nssm set $svcName Start SERVICE_AUTO_START
    nssm set $svcName AppStdout (Join-Path $script:INSTALL_DIR "server.log")
    nssm set $svcName AppStderr (Join-Path $script:INSTALL_DIR "server-error.log")
    nssm set $svcName AppRotateFiles 1
    nssm set $svcName AppRotateBytes 10485760
    
    # Database environment
    $envExtra = "SIGNAL_PORT=21116"
    if ($script:USE_POSTGRESQL -and $script:POSTGRESQL_URI) {
        $envExtra += "`nDB_URL=$($script:POSTGRESQL_URI)"
    }
    nssm set $svcName AppEnvironmentExtra $envExtra
    
    # Privilege separation: drop the Go server to its low-privilege virtual account.
    Set-ServiceLeastPrivilege -ServiceName $svcName -NssmPath "nssm" -Paths @($script:INSTALL_DIR)
    
    Print-Success "BetterDesk server service created (Minimal mode)"
}

#=============================================================================
# Main Installation Function
#===============================================================================

function Do-Install {
    Print-Header
    Write-Host "========== FRESH INSTALLATION ==========" -ForegroundColor White
    Write-Host ""
    
    Detect-Installation
    
    if ($script:INSTALL_STATUS -eq "complete") {
        Print-Warning "BetterDesk is already installed!"
        if (-not $script:AUTO_MODE) {
            if (-not (Confirm-Action "Do you want to reinstall?")) {
                return
            }
        }
        Do-BackupSilent
    }
    
    # Treat as fresh only when no database exists yet. Reinstalls over an
    # existing database preserve the operator's current enrollment policy.
    $script:FRESH_INSTALL = -not $script:DATABASE_OK
    
    Write-Host ""
    Print-Info "Starting BetterDesk Console v$script:VERSION installation..."
    Write-Host ""
    
    # Choose database type (SQLite or PostgreSQL)
    Choose-DatabaseType
    
    if (-not (Install-Dependencies)) { return }
    
    # Setup PostgreSQL if selected
    if ($script:USE_POSTGRESQL) {
        if (-not (Setup-PostgreSQLDatabase)) {
            Print-Error "PostgreSQL setup failed"
            return
        }
    }
    
    if (-not (Install-Binaries)) { Print-Error "Binary installation failed"; return }
    if (-not (Install-Console)) { Print-Error "Console installation failed"; return }
    
    # Generate self-signed TLS certificates (default for fresh installs)
    Generate-SSLCertificates
    
    # Migrate existing SQLite data to PostgreSQL if applicable
    if ($script:USE_POSTGRESQL) {
        Migrate-SQLiteToPostgreSQL
    }
    
    Setup-Services
    Run-Migrations
    $adminPassword = Create-AdminUser
    
    # Configure firewall rules
    Print-Step "Configuring Windows Firewall rules..."
    Configure-Firewall | Out-Null
    
    Start-Services
    
    Write-Host ""
    Print-Success "Installation completed successfully!"
    Write-Host ""
    
    $serverIP = Get-PublicIP
    $publicKey = ""
    $pubKeyPath = Join-Path $script:RUSTDESK_PATH "id_ed25519.pub"
    if (Test-Path $pubKeyPath) {
        $publicKey = (Get-Content $pubKeyPath -Raw).Trim()
    }
    
    $dbTypeInfo = "SQLite"
    if ($script:USE_POSTGRESQL) { $dbTypeInfo = "PostgreSQL" }
    
    $tlsStatus = "Disabled"
    $sslDir = Join-Path $script:RUSTDESK_PATH "ssl"
    if ((Test-Path (Join-Path $sslDir "betterdesk.crt")) -and (Test-Path (Join-Path $sslDir "betterdesk.key"))) {
        $tlsStatus = "Self-signed (auto-generated)"
    }
    
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "              INSTALLATION INFO                             " -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  Panel Web:     " -NoNewline; Write-Host "http://${serverIP}:5000" -ForegroundColor White
    Write-Host "  API Port:      " -NoNewline; Write-Host $script:API_PORT -ForegroundColor White
    Write-Host "  Server ID:     " -NoNewline; Write-Host $serverIP -ForegroundColor White
    Write-Host "  Database:      " -NoNewline; Write-Host $dbTypeInfo -ForegroundColor White
    Write-Host "  TLS:           " -NoNewline; Write-Host $tlsStatus -ForegroundColor White
    if ($publicKey) {
        Write-Host "  Key:           " -NoNewline; Write-Host "$($publicKey.Substring(0, [Math]::Min(20, $publicKey.Length)))..." -ForegroundColor White
    }
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Required ports (ensure firewall allows):" -ForegroundColor Yellow
    Write-Host "    TCP/UDP 21116  - ID Server (client registration)"
    Write-Host "    TCP    21115  - NAT type test"
    Write-Host "    TCP    21117  - Relay Server"
    Write-Host "    TCP    $($script:GO_API_PORT)  - Go API (default, direct)"
    Write-Host "    TCP    5000   - Web Console (admin panel)"
    Write-Host "    TCP    $($script:CLIENT_API_PORT)  - RustDesk client API (backward-compat proxy)"
    Write-Host ""
    Write-Host "  RustDesk Client Configuration:" -ForegroundColor Yellow
    Write-Host "    ID Server:    $serverIP"
    Write-Host "    Relay Server: $serverIP"
    if ($publicKey) {
        Write-Host "    Key:          $publicKey"
    }
    Write-Host ""
    
    # Auto-configure firewall rules
    Write-Host "  Configuring Windows Firewall rules..." -ForegroundColor Cyan
    Configure-Firewall
    Write-Host ""
    
    # Offer HTTPS Enterprise configuration for fresh installs
    if (-not $script:AUTO_MODE) {
        Write-Host ""
        Print-Info "Enterprise TLS enables HTTPS for panel/signal/relay; Go API stays HTTP for compatibility"
        Print-Info "Recommended for production deployments behind trusted operator access"
        Write-Host ""
        if (Confirm-Action "Would you like to configure HTTPS Enterprise now? (Option 5 in SSL menu)") {
            Do-ConfigureSSL
        }
    }
    
    if (-not $script:AUTO_MODE) {
        Press-Enter
    }
}

#===============================================================================
# Update Functions
#===============================================================================

# GitHub repository configuration for online updates
$script:UPDATE_GITHUB_OWNER = if ($env:UPDATE_GITHUB_OWNER) { $env:UPDATE_GITHUB_OWNER } else { "UNITRONIX" }
$script:UPDATE_GITHUB_REPO = if ($env:UPDATE_GITHUB_REPO) { $env:UPDATE_GITHUB_REPO } else { "BetterDesk" }
$script:UPDATE_GITHUB_BRANCH = if ($env:UPDATE_GITHUB_BRANCH) { $env:UPDATE_GITHUB_BRANCH } else { "main" }

function Read-UpdateGitHubBranchFromEnv {
    $envFile = Join-Path $script:CONSOLE_PATH ".env"
    if ($script:CONSOLE_PATH -and (Test-Path $envFile)) {
        $line = Get-Content $envFile -ErrorAction SilentlyContinue |
            Where-Object { $_ -match '^\s*UPDATE_GITHUB_BRANCH=' } |
            Select-Object -Last 1
        if ($line -match '^\s*UPDATE_GITHUB_BRANCH=(.+)$') {
            $script:UPDATE_GITHUB_BRANCH = $Matches[1].Trim().Trim('"')
            $env:UPDATE_GITHUB_BRANCH = $script:UPDATE_GITHUB_BRANCH
        }
    }
}

function Write-UpdateGitHubBranchToEnv {
    param([Parameter(Mandatory = $true)][ValidateSet('main', 'dev')][string]$Branch)
    $envFile = Join-Path $script:CONSOLE_PATH ".env"
    if (-not $script:CONSOLE_PATH) {
        Print-Error "Console path unknown — cannot save update channel"
        return $false
    }
    if (-not (Test-Path $envFile)) {
        New-Item -ItemType File -Path $envFile -Force | Out-Null
    }
    $lines = @(Get-Content $envFile -ErrorAction SilentlyContinue)
    $found = $false
    $updated = foreach ($line in $lines) {
        if ($line -match '^\s*UPDATE_GITHUB_BRANCH=') {
            $found = $true
            "UPDATE_GITHUB_BRANCH=$Branch"
        } else {
            $line
        }
    }
    if (-not $found) {
        $updated = @($updated) + "UPDATE_GITHUB_BRANCH=$Branch"
    }
    Set-Content -Path $envFile -Value $updated -Encoding UTF8
    $script:UPDATE_GITHUB_BRANCH = $Branch
    $env:UPDATE_GITHUB_BRANCH = $Branch
    Print-Success "Update channel saved (GitHub branch: $Branch)"
    return $true
}

function Switch-UpdateChannel {
    Print-Header
    Write-Host "========== UPDATE CHANNEL ==========" -ForegroundColor White
    Write-Host ""
    Detect-Installation
    if ($script:INSTALL_STATUS -eq "none") {
        Print-Error "BetterDesk is not installed!"
        Press-Enter
        return
    }
    Read-UpdateGitHubBranchFromEnv
    Print-Info "Current GitHub branch: $($script:UPDATE_GITHUB_BRANCH)"
    Write-Host ""
    $items = @(
        "Stable (main)`tProduction releases from the main branch",
        "Development (dev)`tLatest work-in-progress from the dev branch",
        "Back`tReturn without changes"
    )
    $returns = @("main", "dev", "0")
    Invoke-MenuChoose -Title "Update Channel" -Subtitle "Stable is recommended for production servers" -Items $items -Returns $returns
    switch ($script:MENU_CHOICE) {
        "0" { return }
        "dev" {
            Print-Warning "Development channel may include unstable changes."
            Write-UpdateGitHubBranchToEnv -Branch "dev" | Out-Null
        }
        default {
            Write-UpdateGitHubBranchToEnv -Branch "main" | Out-Null
        }
    }
    Print-Info "Run 'Check for updates' in the console or use Online GitHub update to apply."
    Press-Enter
}

function Invoke-TerminalProjectUpdate {
    $script:TerminalUpdateExitCode = 2
    $cliPath = Join-Path $script:CONSOLE_PATH "scripts\update-cli.js"
    $node = Get-Command node -ErrorAction SilentlyContinue

    if (-not $node -or -not (Test-Path $cliPath)) {
        return
    }

    Print-Step "Running commit-aware project updater..."
    Print-Info "Updater CLI: $cliPath"

    $args = @()
    if ($script:AUTO_MODE) { $args += "--yes" }

    & $node.Source $cliPath @args
    $script:TerminalUpdateExitCode = $LASTEXITCODE
}

# Pull latest project from GitHub and apply update to local installation.
# Downloads latest code, rebuilds Go server, reinstalls Node.js console.
# All local state (databases, keys, .env, auth.db) is preserved.
function Update-FromGitHub {
    $cloneDir = Join-Path $env:TEMP "betterdesk-update-$PID"
    $script:ServerBuildFailed = $false

    Read-UpdateGitHubBranchFromEnv

    # Clean up any leftover clone from a previous failed run
    if (Test-Path $cloneDir) { Remove-Item -Recurse -Force $cloneDir -ErrorAction SilentlyContinue }

    # ---- Step 1: Clone or download latest code ----
    Print-Step "Downloading latest BetterDesk from GitHub..."
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    $downloaded = $false

    if ($gitCmd) {
        $repoUrl = "https://github.com/$($script:UPDATE_GITHUB_OWNER)/$($script:UPDATE_GITHUB_REPO).git"
        try {
            & git clone --depth 1 --single-branch --branch $script:UPDATE_GITHUB_BRANCH $repoUrl $cloneDir 2>$null
            if ($LASTEXITCODE -eq 0) {
                Print-Success "Repository cloned (branch: $($script:UPDATE_GITHUB_BRANCH))"
                $downloaded = $true
            }
        } catch { }
    }

    if (-not $downloaded) {
        # Fallback: download ZIP archive
        $zipUrl = "https://github.com/$($script:UPDATE_GITHUB_OWNER)/$($script:UPDATE_GITHUB_REPO)/archive/refs/heads/$($script:UPDATE_GITHUB_BRANCH).zip"
        $zipPath = Join-Path $env:TEMP "betterdesk-update-$PID.zip"
        Print-Info "git not available, downloading ZIP archive..."
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $wc = New-Object System.Net.WebClient
            $wc.DownloadFile($zipUrl, $zipPath)
            $wc.Dispose()

            New-Item -ItemType Directory -Path $cloneDir -Force | Out-Null
            Expand-Archive -Path $zipPath -DestinationPath $cloneDir -Force

            # GitHub ZIP extracts into a subdirectory like "BetterDesk-main/"
            $subDir = Get-ChildItem -Path $cloneDir -Directory | Select-Object -First 1
            if ($subDir) {
                Get-ChildItem -Path $subDir.FullName | Move-Item -Destination $cloneDir -Force
                Remove-Item -Path $subDir.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }

            Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue
            Print-Success "Source downloaded and extracted"
            $downloaded = $true
        } catch {
            Print-Error "Download failed: $($_.Exception.Message)"
            Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue
            Remove-Item -Recurse -Force $cloneDir -ErrorAction SilentlyContinue
            return $false
        }
    }

    if (-not $downloaded) {
        Print-Error "Failed to download source code"
        return $false
    }

    # Validate downloaded source
    $goModPath = Join-Path $cloneDir "betterdesk-server\go.mod"
    $serverJsPath = Join-Path $cloneDir "web-nodejs\server.js"
    if (-not (Test-Path $goModPath) -or -not (Test-Path $serverJsPath)) {
        Print-Error "Downloaded source is incomplete or invalid"
        Remove-Item -Recurse -Force $cloneDir -ErrorAction SilentlyContinue
        return $false
    }

    # Read remote version
    $remoteVersion = ""
    $versionFile = Join-Path $cloneDir "VERSION"
    if (Test-Path $versionFile) {
        $remoteVersion = (Get-Content $versionFile -Raw).Trim()
    }
    if ($remoteVersion) {
        Print-Info "Remote version: $remoteVersion"
    }

    # ---- Step 2: Update Go server source & compile ----
    Print-Step "Updating Go server source..."
    $goServerSource = $script:GO_SERVER_SOURCE
    if (Test-Path $goServerSource) {
        $backupName = "$goServerSource.pre-update.$PID"
        Rename-Item -Path $goServerSource -NewName $backupName -ErrorAction SilentlyContinue
    }
    $sourceDir = Join-Path $cloneDir "betterdesk-server"
    # Copy the *contents* into a guaranteed-existing destination. Copying the
    # directory itself would nest the new tree inside an existing
    # $goServerSource if the rename above failed (e.g. a momentarily locked
    # file), leaving the old inconsistent source in place and breaking
    # `go build` with "undefined" errors (issue #158).
    New-Item -ItemType Directory -Path $goServerSource -Force | Out-Null
    Copy-Item -Path "$sourceDir\*" -Destination $goServerSource -Recurse -Force

    # Restore any local data/ directory from old source
    $oldDataDir = "$goServerSource.pre-update.$PID\data"
    if (Test-Path $oldDataDir) {
        Copy-Item -Path "$oldDataDir\*" -Destination (Join-Path $goServerSource "data") -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -Path "$goServerSource.pre-update.$PID" -Recurse -Force -ErrorAction SilentlyContinue
    Print-Success "Go server source updated"

    # Compile Go server
    Print-Step "Building Go server..."
    $goAvailable = Test-GoInstalled
    if (-not $goAvailable) {
        Print-Info "Installing Go toolchain..."
        Install-Golang
        $goAvailable = Test-GoInstalled
    }

    if ($goAvailable) {
        if (Compile-GoServer) {
            Print-Success "Go server compiled successfully"
            $builtBinary = Join-Path $goServerSource "betterdesk-server.exe"
            if (Test-Path $builtBinary) {
                $targetBinary = Join-Path $script:RUSTDESK_PATH "betterdesk-server.exe"
                if (Test-Path $targetBinary) {
                    $ts = Get-Date -Format "yyyyMMddHHmmss"
                    Copy-Item $targetBinary "$targetBinary.bak.$ts" -ErrorAction SilentlyContinue
                }
                Copy-Item $builtBinary $targetBinary -Force
                Print-Success "Go server binary deployed to $($script:RUSTDESK_PATH)"
            }
        } else {
            Print-Warning "Go server compilation failed -- keeping existing binary"
            Print-Info "Use the panel Rebuild server binary button or option 7 (Build & deploy server)"
            $script:ServerBuildFailed = $true
        }
    } else {
        Print-Warning "Go toolchain not available -- server binary not updated"
        Print-Info "Install Go manually from https://go.dev/dl/ and re-run update"
        $script:ServerBuildFailed = $true
    }

    # ---- Step 3: Update Node.js console files ----
    Print-Step "Updating Node.js web console..."

    # Files/directories to preserve during console update
    $preserveItems = @(".env", ".env.local", "data", "node_modules")
    $preservedDir = Join-Path $env:TEMP "betterdesk-console-state-$PID"
    New-Item -ItemType Directory -Path $preservedDir -Force | Out-Null

    foreach ($item in $preserveItems) {
        $src = Join-Path $script:CONSOLE_PATH $item
        if (Test-Path $src) {
            $dst = Join-Path $preservedDir $item
            Copy-Item -Path $src -Destination $dst -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # Copy new console files
    $consoleSrc = Join-Path $cloneDir "web-nodejs"
    Copy-Item -Path "$consoleSrc\*" -Destination $script:CONSOLE_PATH -Recurse -Force
    $envExampleSrc = Join-Path $consoleSrc ".env.example"
    if (Test-Path $envExampleSrc) {
        Copy-Item -Path $envExampleSrc -Destination (Join-Path $script:CONSOLE_PATH ".env.example") -Force
    }

    # Restore preserved state files
    foreach ($item in $preserveItems) {
        $src = Join-Path $preservedDir $item
        if (Test-Path $src) {
            $dst = Join-Path $script:CONSOLE_PATH $item
            if (Test-Path $src -PathType Container) {
                if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
                Copy-Item -Path "$src\*" -Destination $dst -Recurse -Force -ErrorAction SilentlyContinue
            } else {
                Copy-Item -Path $src -Destination $dst -Force -ErrorAction SilentlyContinue
            }
        }
    }
    Remove-Item -Path $preservedDir -Recurse -Force -ErrorAction SilentlyContinue
    Print-Success "Console files updated"

    # Install npm dependencies
    Print-Step "Installing npm dependencies..."
    Push-Location $script:CONSOLE_PATH
    try {
        & npm install --production --no-audit --no-fund 2>$null
        if ($LASTEXITCODE -eq 0) {
            Print-Success "npm dependencies installed"
        } else {
            Print-Warning "npm install had issues (non-critical)"
        }
    } catch {
        Print-Warning "npm install failed (non-critical): $($_.Exception.Message)"
    }
    Pop-Location

    # Merge any new .env keys from .env.example (preserve operator settings — issue #158)
    Print-Step "Merging new .env configuration keys..."
    if (-not (Merge-ConsoleEnv -FreshInstall:$false)) {
        Print-Warning ".env merge skipped (merge-env.js unavailable)"
    }

    # ---- Step 4: Update installer scripts ----
    Print-Step "Updating installer scripts..."
    $scriptFiles = @(
        "betterdesk.sh", "betterdesk.ps1", "betterdesk-docker.sh",
        "docker-compose.yml", "docker-compose.single.yml", "docker-compose.quick.yml",
        "docker-compose.quick.single.yml", "docker-compose.quick.single.macvlan.yml",
        "Dockerfile", "Dockerfile.server", "Dockerfile.console", "VERSION"
    )
    $scriptsUpdated = 0
    foreach ($sf in $scriptFiles) {
        $src = Join-Path $cloneDir $sf
        if (Test-Path $src) {
            Copy-Item -Path $src -Destination (Join-Path $script:ScriptDir $sf) -Force -ErrorAction SilentlyContinue
            $scriptsUpdated++
        }
    }
    Print-Success "$scriptsUpdated installer files updated"

    # ---- Step 5: Update SHA tracking for in-app updater ----
    $gitCmd2 = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd2 -and (Test-Path (Join-Path $cloneDir ".git"))) {
        try {
            $remoteSha = (& git -C $cloneDir rev-parse HEAD 2>$null).Trim()
            if ($remoteSha) {
                $dataDir = Join-Path $script:CONSOLE_PATH "data"
                if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
                Set-Content -Path (Join-Path $dataDir ".update_sha") -Value $remoteSha
                Set-Content -Path (Join-Path $dataDir ".agent_source_sha") -Value $remoteSha
                Remove-Item -Path (Join-Path $dataDir ".last_update_result.json") -Force -ErrorAction SilentlyContinue
                Print-Info "SHA tracking updated: $($remoteSha.Substring(0, 7))"
            }
        } catch { }
    }

    # ---- Step 6: Update VERSION file ----
    if ($remoteVersion -and (Test-Path (Join-Path $cloneDir "VERSION"))) {
        Copy-Item -Path (Join-Path $cloneDir "VERSION") -Destination (Join-Path $script:ScriptDir "VERSION") -Force -ErrorAction SilentlyContinue
        Copy-Item -Path (Join-Path $cloneDir "VERSION") -Destination (Join-Path $script:CONSOLE_PATH "VERSION") -Force -ErrorAction SilentlyContinue
    }

    # Cleanup
    Remove-Item -Recurse -Force $cloneDir -ErrorAction SilentlyContinue

    Print-Success "All project files updated from GitHub"
    if ($script:ServerBuildFailed) {
        Print-Error "Go server binary was not rebuilt — update incomplete for server component"
        return $false
    }
    return $true
}

function Do-Update {
    Print-Header
    Write-Host "========== UPDATE ==========" -ForegroundColor White
    Write-Host ""
    
    Detect-Installation
    
    if ($script:INSTALL_STATUS -eq "none") {
        Print-Error "BetterDesk is not installed!"
        Print-Info "Use 'FRESH INSTALLATION' option"
        Press-Enter
        return
    }
    
    # Detect Rust -> Go upgrade (major architecture change)
    if ($script:SERVER_TYPE -eq "rust") {
        Print-Warning "Legacy Rust server (hbbs/hbbr) detected!"
        Print-Warning "Upgrading from Rust to Go server requires a FRESH INSTALLATION."
        Print-Info "The Go server is a single binary replacing both hbbs and hbbr."
        Print-Info "Your data (keys, database) will be preserved during migration."
        Write-Host ""
        if (-not $script:AUTO_MODE) {
            if (Confirm-Action "Proceed with fresh installation (recommended)?") {
                Do-Install
                return
            } else {
                Print-Warning "Continuing with update -- legacy Rust binaries will NOT be replaced with Go server."
            }
        } else {
            Print-Info "Auto mode: Redirecting to fresh installation for Rust -> Go migration"
            Do-Install
            return
        }
    }
    
    # CRITICAL: Preserve database configuration before reinstalling console
    # This prevents PostgreSQL -> SQLite switch during updates
    Preserve-DatabaseConfig

    # ---- Update method selection ----
    Read-UpdateGitHubBranchFromEnv
    Print-Info "GitHub update branch: $($script:UPDATE_GITHUB_BRANCH)"

    if ($script:AUTO_MODE) {
        Print-Info "Auto mode: using GitHub pull update"
    } else {
        $items = @(
            "Online update from GitHub`tDownload latest code + rebuild (recommended)",
            "In-app updater`tBuilt-in Node.js commit-aware updater",
            "Local update`tCopy files from this script's directory",
            "Switch update channel`tChoose stable (main) or development (dev) branch",
            "Back`tReturn to the main menu"
        )
        $returns = @("1", "2", "3", "4", "0")
        Invoke-MenuChoose -Title "Update Method" -Subtitle "Online GitHub update is recommended" -Items $items -Returns $returns
        $updateMethod = $script:MENU_CHOICE
        if (-not $updateMethod) { $updateMethod = "1" }

        switch ($updateMethod) {
            "0" {
                return
            }
            "4" {
                Switch-UpdateChannel
                return
            }
            "2" {
                Invoke-TerminalProjectUpdate
                if ($script:TerminalUpdateExitCode -eq 0) {
                    Print-Success "Online project update completed"
                } elseif ($script:TerminalUpdateExitCode -ne 2) {
                    Print-Error "In-app update failed (exit code: $($script:TerminalUpdateExitCode))"
                } else {
                    Print-Error "In-app updater not available (Node.js or CLI script missing)"
                }
                Press-Enter
                return
            }
            "3" {
                # Legacy local update path
                Print-Info "Using local files from: $($script:ScriptDir)"
                Print-Info "Creating backup before update..."
                Do-BackupSilent
                Stop-AllServices
                if (-not (Install-Binaries -ForceRecompile)) { Print-Error "Binary update failed"; return }
                if (-not (Install-Console)) { Print-Error "Console update failed"; return }
                Run-Migrations
                Maybe-UpdateServices
                Create-AdminUser | Out-Null
                Start-Services
                Print-Success "Local update completed!"
                Press-Enter
                return
            }
        }
    }

    # ---- GitHub Pull Update ----
    Print-Info "Creating backup before update..."
    Do-BackupSilent

    # Stop services before updating files
    Stop-AllServices

    $result = Update-FromGitHub
    if (-not $result) {
        Print-Error "GitHub update failed"
        Print-Info "Attempting to restart services with existing files..."
        Start-Services
        Press-Enter
        return
    }

    # Run database migrations
    Run-Migrations
    
    $svcMode = 'default'
    if (-not $script:AUTO_MODE) {
        Write-Host ""
        $recreateSvc = Read-Host "Recreate Windows service definitions from installer template? [y/N]"
        if ($recreateSvc -match '^(y|yes)$') { $svcMode = 'recreate' }
    }

    Maybe-UpdateServices -Mode $svcMode
    
    # Informational; panel passwords live in auth.db / PostgreSQL
    Create-AdminUser | Out-Null
    
    Start-Services
    
    Print-Success "Update completed!"
    Press-Enter
}

#===============================================================================
# Repair Functions
#===============================================================================

function Do-Repair {
    Print-Header
    Write-Host "========== REPAIR INSTALLATION ==========" -ForegroundColor White
    Write-Host ""
    
    Detect-Installation
    
    # CRITICAL: Preserve database configuration before any repair operation
    # This prevents PostgreSQL -> SQLite switch when regenerating service files
    Preserve-DatabaseConfig
    
    Print-Status
    
    $items = @(
        "Repair binaries`tReplace the server binary with BetterDesk",
        "Repair database`tAdd any missing columns",
        "Repair services`tRecreate the Windows services",
        "Full repair`tDo everything above",
        "Back`tReturn to the main menu"
    )
    $returns = @("1", "2", "3", "4", "0")
    Invoke-MenuChoose -Title "Repair Installation" -Subtitle "Choose what to repair" -Items $items -Returns $returns
    $choice = $script:MENU_CHOICE
    
    switch ($choice) {
        "1" { Repair-Binaries }
        "2" { Repair-Database }
        "3" { Repair-Services }
        "4" { 
            Repair-Binaries
            Repair-Database
            Repair-Services
            Print-Success "Full repair completed!"
        }
        "0" { return }
    }
    
    Press-Enter
}

function Repair-Binaries {
    Print-Step "Repairing binaries (enhanced v2.1.2)..."
    
    # Verify binaries exist
    $binSource = Join-Path $script:ScriptDir "hbbs-patch-v2"
    $hbbsPath = Join-Path $binSource "hbbs-windows-x86_64.exe"
    $hbbrPath = Join-Path $binSource "hbbr-windows-x86_64.exe"
    
    if (-not (Test-Path $hbbsPath) -or -not (Test-Path $hbbrPath)) {
        Print-Error "BetterDesk binaries not found in $binSource"
        return
    }
    
    # Backup current binaries
    $timestamp = Get-Date -Format "yyyyMMddHHmmss"
    if (Test-Path "$script:RUSTDESK_PATH\hbbs.exe") {
        Copy-Item "$script:RUSTDESK_PATH\hbbs.exe" "$script:RUSTDESK_PATH\hbbs.exe.backup.$timestamp" -ErrorAction SilentlyContinue
    }
    if (Test-Path "$script:RUSTDESK_PATH\hbbr.exe") {
        Copy-Item "$script:RUSTDESK_PATH\hbbr.exe" "$script:RUSTDESK_PATH\hbbr.exe.backup.$timestamp" -ErrorAction SilentlyContinue
    }
    
    # Stop services and wait
    Stop-AllServices
    Start-Sleep -Seconds 3
    
    # Extra check - make sure files are not locked
    $hbbsLocked = $false
    $hbbrLocked = $false
    
    try {
        if (Test-Path "$script:RUSTDESK_PATH\betterdesk-server.exe") {
            $stream = [System.IO.File]::Open("$script:RUSTDESK_PATH\betterdesk-server.exe", 'Open', 'ReadWrite', 'None')
            $stream.Close()
        } elseif (Test-Path "$script:RUSTDESK_PATH\hbbs.exe") {
            $stream = [System.IO.File]::Open("$script:RUSTDESK_PATH\hbbs.exe", 'Open', 'ReadWrite', 'None')
            $stream.Close()
        }
    } catch {
        $hbbsLocked = $true
        Print-Warning "Server binary is still locked, killing stale processes..."
        Get-Process -Name "betterdesk-server" -ErrorAction SilentlyContinue | Stop-Process -Force
        Get-Process -Name "hbbs" -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 2
    }
    
    try {
        # Legacy hbbr check (Go server no longer uses separate relay binary)
        if (Test-Path "$script:RUSTDESK_PATH\hbbr.exe") {
            $stream = [System.IO.File]::Open("$script:RUSTDESK_PATH\hbbr.exe", 'Open', 'ReadWrite', 'None')
            $stream.Close()
        }
    } catch {
        $hbbrLocked = $true
        Print-Warning "hbbr.exe is still locked, killing stale processes..."
        Get-Process -Name "hbbr" -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 2
    }
    
    # Install binaries
    if (-not (Install-Binaries)) {
        Print-Error "Failed to install binaries"
        return
    }
    
    # Start with verification
    if (-not (Start-ServicesWithVerification)) {
        Print-Error "Services failed to start after repair"
        return
    }
    
    Print-Success "Binaries repaired and verified!"
}

function Repair-Database {
    Print-Step "Repairing database..."
    
    Run-Migrations
    
    Print-Success "Database repaired"
}

function Repair-Services {
    Print-Step "Repairing Windows services (enhanced v2.1.2)..."
    
    # Stop services first
    Stop-AllServices
    Start-Sleep -Seconds 2
    
    # Verify binaries exist (Go server: betterdesk-server.exe, fallback: legacy hbbs.exe)
    $serverBinary = Join-Path $script:RUSTDESK_PATH "betterdesk-server.exe"
    if (-not (Test-Path $serverBinary)) {
        # Fallback to legacy Rust binary name
        $serverBinary = Join-Path $script:RUSTDESK_PATH "hbbs.exe"
        if (-not (Test-Path $serverBinary)) {
            Print-Error "betterdesk-server.exe not found at $script:RUSTDESK_PATH"
            Print-Info "Run 'Repair binaries' first"
            return
        }
    }
    
    # Recreate services/tasks
    Setup-Services
    
    # Start with verification
    if (-not (Start-ServicesWithVerification)) {
        Print-Error "Services failed to start after repair"
        return
    }
    
    Print-Success "Services repaired and verified!"
}

#===============================================================================
# Validation Functions
#===============================================================================

function Do-Validate {
    Print-Header
    Write-Host "========== INSTALLATION VALIDATION ==========" -ForegroundColor White
    Write-Host ""
    
    $errors = 0
    $warnings = 0
    
    Detect-Installation
    
    Write-Host "Checking components..." -ForegroundColor White
    Write-Host ""
    
    # Check directories
    Write-Host "  RustDesk directory ($script:RUSTDESK_PATH): " -NoNewline
    if (Test-Path $script:RUSTDESK_PATH) {
        Write-Host "[OK]" -ForegroundColor Green
    } else {
        Write-Host "[X] Not found" -ForegroundColor Red
        $errors++
    }
    
    Write-Host "  Console directory ($script:CONSOLE_PATH): " -NoNewline
    if (Test-Path $script:CONSOLE_PATH) {
        Write-Host "[OK]" -ForegroundColor Green
    } else {
        Write-Host "[X] Not found" -ForegroundColor Red
        $errors++
    }
    
    # Check binaries (Go server or legacy Rust)
    Write-Host "  BetterDesk Server: " -NoNewline
    if (Test-Path (Join-Path $script:RUSTDESK_PATH "betterdesk-server.exe")) {
        Write-Host "[OK] (Go: signal + relay + API)" -ForegroundColor Green
    } elseif ((Test-Path (Join-Path $script:RUSTDESK_PATH "hbbs.exe")) -and (Test-Path (Join-Path $script:RUSTDESK_PATH "hbbr.exe"))) {
        Write-Host "[OK] (Legacy Rust)" -ForegroundColor Yellow
        $warnings++
    } else {
        Write-Host "[X] Not found" -ForegroundColor Red
        $errors++
    }
    
    # Check database (SQLite or PostgreSQL)
    Write-Host "  Database: " -NoNewline
    $valDbType = "sqlite"
    $envFilePath = Join-Path $script:CONSOLE_PATH ".env"
    if (Test-Path $envFilePath) {
        $dbLine = Select-String -Path $envFilePath -Pattern '^DB_TYPE=' -SimpleMatch | Select-Object -First 1
        if ($dbLine) { $valDbType = ($dbLine.Line -split '=', 2)[1].Trim() }
    }
    if ($valDbType -eq "postgres") {
        Write-Host "[OK] (PostgreSQL)" -ForegroundColor Green
    } elseif (Test-Path $script:DB_PATH) {
        Write-Host "[OK] (SQLite)" -ForegroundColor Green
    } else {
        # Go server creates DB on first start
        Write-Host "[!] Not yet created (will be created when server starts)" -ForegroundColor Yellow
        $warnings++
    }
    
    # Check keys
    Write-Host "  Public key: " -NoNewline
    $pubKeyPath = Join-Path $script:RUSTDESK_PATH "id_ed25519.pub"
    if (Test-Path $pubKeyPath) {
        Write-Host "[OK]" -ForegroundColor Green
    } else {
        Write-Host "[!] Will be generated on first start" -ForegroundColor Yellow
        $warnings++
    }
    
    # Check services
    Write-Host ""
    Write-Host "Checking services..." -ForegroundColor White
    Write-Host ""
    
    $services = @($script:HBBS_SERVICE, $script:HBBR_SERVICE, $script:CONSOLE_SERVICE)
    foreach ($service in $services) {
        Write-Host "  ${service}: " -NoNewline
        $svc = Get-Service -Name $service -ErrorAction SilentlyContinue
        if ($svc) {
            if ($svc.Status -eq 'Running') {
                Write-Host "[OK] Running" -ForegroundColor Green
            } else {
                Write-Host "[!] Not running ($($svc.Status))" -ForegroundColor Yellow
                $warnings++
            }
        } else {
            $task = Get-ScheduledTask -TaskName $service -ErrorAction SilentlyContinue
            if ($task) {
                if ($task.State -eq 'Running') {
                    Write-Host "[OK] Running (task)" -ForegroundColor Green
                } else {
                    Write-Host "[!] Task exists but not running" -ForegroundColor Yellow
                    $warnings++
                }
            } else {
                Write-Host "[X] Not found" -ForegroundColor Red
                $errors++
            }
        }
    }
    
    # Check ports
    Write-Host ""
    Write-Host "Checking ports..." -ForegroundColor White
    Write-Host ""
    
    $ports = @(
        @{Port=[int]$script:GO_API_PORT; Desc="Go API"; Expected="betterdesk-server"},
        @{Port=[int]$script:CLIENT_API_PORT; Desc="Client API proxy"; Expected="node"},
        @{Port=21115; Desc="NAT Test"; Expected="hbbs"},
        @{Port=21116; Desc="ID Server"; Expected="hbbs"},
        @{Port=21117; Desc="Relay"; Expected="hbbr"},
        @{Port=5000;  Desc="Web Console"; Expected="node"}
    )
    foreach ($p in $ports) {
        $status = Check-PortStatus -Port $p.Port -Protocol "TCP" -ExpectedService $p.Expected
        Write-Host "  Port $($p.Port) ($($p.Desc)): " -NoNewline
        if ($status.Listening) {
            if ($status.Conflict) {
                Write-Host "[!] CONFLICT - $($status.ProcessName) (PID $($status.PID))" -ForegroundColor Red
                $errors++
            } else {
                Write-Host "[OK] $($status.ProcessName)" -ForegroundColor Green
            }
        } else {
            Write-Host "[!] Not listening" -ForegroundColor Yellow
            $warnings++
        }
    }
    
    # Check firewall
    Write-Host ""
    Write-Host "Checking firewall..." -ForegroundColor White
    Write-Host ""
    
    $firewallProfile = Get-NetFirewallProfile -ErrorAction SilentlyContinue
    $activeProfiles = $firewallProfile | Where-Object { $_.Enabled -eq $true }
    if ($activeProfiles) {
        $fwPorts = @(21115, 21116, 21117, 21118, 21119, 5000, 5443, [int]$script:GO_API_PORT, [int]$script:CLIENT_API_PORT)
        $fwMissing = 0
        foreach ($fwPort in $fwPorts) {
            $rules = Get-NetFirewallRule -Direction Inbound -Enabled True -ErrorAction SilentlyContinue | 
                Where-Object { $_.Action -eq 'Allow' } |
                Get-NetFirewallPortFilter -ErrorAction SilentlyContinue | 
                Where-Object { $_.LocalPort -eq $fwPort }
            if (-not $rules) { $fwMissing++ }
        }
        if ($fwMissing -gt 0) {
            Write-Host "  Firewall: $fwMissing rule(s) missing" -ForegroundColor Yellow
            Write-Host "  Use DIAGNOSTICS > F to auto-configure" -ForegroundColor Yellow
            $warnings += $fwMissing
        } else {
            Write-Host "  Firewall: All rules configured" -ForegroundColor Green
        }
    } else {
        Write-Host "  Firewall: Disabled" -ForegroundColor Green
    }
    
    # Summary
    Write-Host ""
    Write-Host "=======================================" -ForegroundColor White
    
    if ($errors -eq 0 -and $warnings -eq 0) {
        Write-Host "[OK] Installation correct - no problems found" -ForegroundColor Green
    } elseif ($errors -eq 0) {
        Write-Host "[!] Found $warnings warning(s)" -ForegroundColor Yellow
    } else {
        Write-Host "[X] Found $errors error(s) and $warnings warning(s)" -ForegroundColor Red
        Write-Host "Use 'REPAIR INSTALLATION' option to fix problems" -ForegroundColor Cyan
    }
    
    Press-Enter
}

#===============================================================================
# Backup Functions
#===============================================================================

function Do-Backup {
    Print-Header
    Write-Host "========== BACKUP ==========" -ForegroundColor White
    Write-Host ""
    
    Do-BackupSilent
    
    Print-Success "Backup completed!"
    Press-Enter
}

function Do-BackupSilent {
    $backupName = "betterdesk_backup_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
    $backupPath = Join-Path $script:BACKUP_DIR $backupName
    
    if (-not (Test-Path $script:BACKUP_DIR)) {
        New-Item -ItemType Directory -Path $script:BACKUP_DIR -Force | Out-Null
    }
    
    New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
    
    Print-Step "Creating backup: $backupName"
    
    # Backup database
    if (Test-Path $script:DB_PATH) {
        Copy-Item -Path $script:DB_PATH -Destination $backupPath
        Print-Info "  - Database"
    }
    
    # Backup keys
    $keyPath = Join-Path $script:RUSTDESK_PATH "id_ed25519"
    if (Test-Path $keyPath) {
        Copy-Item -Path $keyPath -Destination $backupPath
        Copy-Item -Path "$keyPath.pub" -Destination $backupPath -ErrorAction SilentlyContinue
        Print-Info "  - Keys"
    }
    
    # Backup API key
    $apiKeyPath = Join-Path $script:RUSTDESK_PATH ".api_key"
    if (Test-Path $apiKeyPath) {
        Copy-Item -Path $apiKeyPath -Destination $backupPath
        Print-Info "  - API key"
    }
    
    # Backup credentials (check both locations)
    $consoleCredPath = Join-Path $script:CONSOLE_PATH "data\.admin_credentials"
    $rustdeskCredPath = Join-Path $script:RUSTDESK_PATH ".admin_credentials"
    if (Test-Path $consoleCredPath) {
        Copy-Item -Path $consoleCredPath -Destination $backupPath
        Print-Info "  - Login credentials"
    } elseif (Test-Path $rustdeskCredPath) {
        Copy-Item -Path $rustdeskCredPath -Destination $backupPath
        Print-Info "  - Login credentials"
    }
    
    # Create zip archive
    $zipPath = "$backupPath.zip"
    Compress-Archive -Path $backupPath -DestinationPath $zipPath -Force
    Remove-Item -Path $backupPath -Recurse -Force
    
    Print-Success "Backup saved: $zipPath"
}

#===============================================================================
# Password Reset Function
#===============================================================================

function Do-ResetPassword {
    Print-Header
    Write-Host "========== ADMIN PASSWORD RESET ==========" -ForegroundColor White
    Write-Host ""
    
    # Detect console type
    Detect-Installation
    
    if ($script:CONSOLE_TYPE -eq "none") {
        Print-Error "No console installation detected"
        Print-Info "Run installation first"
        Press-Enter
        return
    }
    
    $items = @(
        "Generate random password`tCreate a new strong password",
        "Set custom password`tType the password yourself",
        "Back`tReturn to the main menu"
    )
    $returns = @("1", "2", "0")
    Invoke-MenuChoose -Title "Admin Password Reset" -Subtitle "Console type: Node.js" -Items $items -Returns $returns
    $choice = $script:MENU_CHOICE
    
    $newPassword = $null
    
    switch ($choice) {
        "1" { $newPassword = Generate-RandomPassword }
        "2" { 
            $newPassword = Read-Host "Enter new password (min 8 chars)"
            if ($newPassword.Length -lt 8) {
                Print-Error "Password too short!"
                Press-Enter
                return
            }
        }
        "0" { return }
        default { return }
    }
    
    if (-not $newPassword) { return }
    
    $success = $false
    
    if ($script:CONSOLE_TYPE -eq "nodejs") {
        # --- Hotfix: detect broken Go-first auth flow (commit 188991d) ---
        $authServicePath = Join-Path $script:CONSOLE_PATH "services\authService.js"
        if (Test-Path $authServicePath) {
            $authContent = Get-Content $authServicePath -Raw -ErrorAction SilentlyContinue
            if ($authContent -match 'const health = await checkGoServerHealth') {
                Print-Warning "Detected broken authentication flow (Go-first delegation bug)"
                Print-Info "Downloading fixed authService.js from GitHub..."
                $fixUrl = "https://raw.githubusercontent.com/UNITRONIX/BetterDesk/main/web-nodejs/services/authService.js"
                $tmpPath = "$authServicePath.tmp"
                try {
                    Invoke-WebRequest -Uri $fixUrl -OutFile $tmpPath -UseBasicParsing -ErrorAction Stop
                    $tmpContent = Get-Content $tmpPath -Raw
                    if ($tmpContent -match 'Step 1: Check local database FIRST') {
                        Move-Item -Path $tmpPath -Destination $authServicePath -Force
                        Print-Success "Fixed authentication flow (restored local-first login)"
                    } else {
                        Remove-Item $tmpPath -Force -ErrorAction SilentlyContinue
                        Print-Warning "Downloaded file does not contain expected fix - skipped"
                    }
                } catch {
                    Remove-Item $tmpPath -Force -ErrorAction SilentlyContinue
                    Print-Warning "Could not download fix (no internet?) - password reset will proceed but login may still fail"
                    Print-Info "Manual fix: download $fixUrl to $authServicePath"
                }
            }
        }

        # Detect database type from console .env
        $dbType = "sqlite"
        $envFile = Join-Path $script:CONSOLE_PATH ".env"
        if (Test-Path $envFile) {
            $envContent = Get-Content $envFile -Raw -ErrorAction SilentlyContinue
            if ($envContent -match '(?m)^DB_TYPE\s*=\s*(postgres|postgresql)') {
                $dbType = "postgres"
            }
        }
        
        Print-Info "Database type: $dbType"
        
        # Use Node.js reset-password script (supports both SQLite and PostgreSQL)
        $resetScript = Join-Path $script:CONSOLE_PATH "scripts\reset-password.js"
        if (Test-Path $resetScript) {
            Print-Info "Using reset-password.js script..."
            $nodeExe = Get-Command "node" -ErrorAction SilentlyContinue
            if ($nodeExe) {
                Push-Location $script:CONSOLE_PATH
                try {
                    $env:DATA_DIR = Join-Path $script:CONSOLE_PATH "data"
                    # The script reads .env for DB_TYPE and DATABASE_URL automatically
                    & node $resetScript $newPassword admin
                    if ($LASTEXITCODE -eq 0) {
                        $success = $true
                    }
                } finally {
                    Pop-Location
                }
            }
        }
        
        # Fallback: direct database update
        if (-not $success) {
            Print-Info "Using direct database update..."
            
            if ($dbType -eq "postgres") {
                # PostgreSQL mode -- need psycopg2 or pg module
                Print-Warning "PostgreSQL password reset requires Node.js. Please ensure node is installed."
                Print-Info "Alternatively, run: psql DATABASE_URL -c `"UPDATE users SET password_hash='...' WHERE username='admin'`""
            } else {
                # SQLite mode -- update auth.db directly
                $authDbPath = Join-Path $script:CONSOLE_PATH "data\auth.db"
                if (-not (Test-Path $authDbPath)) {
                    $authDbPath = Join-Path $script:RUSTDESK_PATH "auth.db"
                }
                Print-Info "Auth database: $authDbPath"
                
                $env:BETTERDESK_AUTH_DB_PATH = $authDbPath
                $env:BETTERDESK_RESET_PASSWORD = $newPassword
                $pythonScript = @"
import sqlite3
import bcrypt
import os

auth_db_path = os.environ.get('BETTERDESK_AUTH_DB_PATH', '')

# Create parent directory if needed
os.makedirs(os.path.dirname(auth_db_path), exist_ok=True)

conn = sqlite3.connect(auth_db_path)
cursor = conn.cursor()

# Ensure table exists (for fresh installations)
cursor.execute('''CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
)''')

new_password = os.environ.get('BETTERDESK_RESET_PASSWORD', '')
password_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt(12)).decode()

cursor.execute("UPDATE users SET password_hash = ? WHERE username = 'admin'", (password_hash,))

if cursor.rowcount == 0:
    cursor.execute('''INSERT INTO users (username, password_hash, role)
                      VALUES ('admin', ?, 'admin')''', (password_hash,))

conn.commit()
conn.close()
print("Password updated successfully")
"@
                $output = $pythonScript | python 2>&1
                Remove-Item Env:BETTERDESK_AUTH_DB_PATH -ErrorAction SilentlyContinue
                Remove-Item Env:BETTERDESK_RESET_PASSWORD -ErrorAction SilentlyContinue
                if ($output -match "successfully") {
                    $success = $true
                } else {
                    Print-Warning "Python output: $output"
                }
            }
        }
    }
    
    Write-Host ""
    if ($success) {
        Write-Host "============================================================" -ForegroundColor Green
        Write-Host "              NEW LOGIN CREDENTIALS                         " -ForegroundColor Green
        Write-Host "============================================================" -ForegroundColor Green
        Write-Host "  Login:    " -NoNewline; Write-Host "admin" -ForegroundColor White
        Write-Host "  Password: " -NoNewline; Write-Host $newPassword -ForegroundColor White
        Write-Host "============================================================" -ForegroundColor Green
        
        if ($script:STORE_ADMIN_CREDENTIALS) {
            # Legacy behavior (opt-in): persist plaintext credentials
            $consoleCredsFile = Join-Path $script:CONSOLE_PATH "data\.admin_credentials"
            $rustdeskCredsFile = Join-Path $script:RUSTDESK_PATH ".admin_credentials"

            # Create console data directory if it doesn't exist
            $consoleDataDir = Join-Path $script:CONSOLE_PATH "data"
            if (-not (Test-Path $consoleDataDir)) {
                New-Item -ItemType Directory -Path $consoleDataDir -Force | Out-Null
            }

            $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            @("Admin Username: admin", "Admin Password: $newPassword", "Generated by: BetterDesk password reset", "Timestamp: $timestamp") | Out-File -FilePath $consoleCredsFile -Encoding UTF8
            @("Admin Username: admin", "Admin Password: $newPassword", "Generated by: BetterDesk password reset", "Timestamp: $timestamp") | Out-File -FilePath $rustdeskCredsFile -Encoding UTF8
            Print-Info "Credentials saved to: $consoleCredsFile"
        } else {
            Print-Warning "Credentials are not persisted by default (security hardening)."
        }
    } else {
        Print-Error "Failed to reset password!"
        Print-Info "Make sure Node.js is installed and the console is set up correctly"
    }
    
    Press-Enter
}

#===============================================================================
# Diagnostics Function
#===============================================================================

function Check-PortStatus {
    param(
        [int]$Port,
        [string]$Protocol = "TCP",
        [string]$ExpectedService = ""
    )
    
    $result = @{
        Port = $Port
        Protocol = $Protocol
        Listening = $false
        ProcessName = ""
        PID = 0
        Conflict = $false
    }
    
    if ($Protocol -eq "TCP") {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    } else {
        $conn = Get-NetUDPEndpoint -LocalPort $Port -ErrorAction SilentlyContinue
    }
    
    if ($conn) {
        $result.Listening = $true
        $result.PID = $conn[0].OwningProcess
        try {
            $proc = Get-Process -Id $result.PID -ErrorAction SilentlyContinue
            $result.ProcessName = $proc.ProcessName
        } catch { }
        
        if ($ExpectedService -and $result.ProcessName -and 
            $result.ProcessName -notmatch $ExpectedService) {
            $result.Conflict = $true
        }
    }
    
    return $result
}

function Check-FirewallRules {
    Write-Host ""
    Write-Host "=== Windows Firewall ===" -ForegroundColor White
    Write-Host ""
    
    $firewallProfile = Get-NetFirewallProfile -ErrorAction SilentlyContinue
    if (-not $firewallProfile) {
        Print-Warning "  Unable to query Windows Firewall"
        return
    }
    
    $activeProfiles = $firewallProfile | Where-Object { $_.Enabled -eq $true }
    if ($activeProfiles) {
        $profileNames = ($activeProfiles | ForEach-Object { $_.Name }) -join ", "
        Write-Host "  Firewall active: $profileNames" -ForegroundColor Yellow
    } else {
        Write-Host "  Firewall: Disabled" -ForegroundColor Green
        return
    }
    
    # Check for BetterDesk firewall rules
    $requiredPorts = @(
        @{Port=21115; Proto="TCP";  Name="NAT Test"},
        @{Port=21116; Proto="TCP";  Name="ID Server TCP"},
        @{Port=21116; Proto="UDP";  Name="ID Server UDP"},
        @{Port=21117; Proto="TCP";  Name="Relay Server"},
        @{Port=21118; Proto="TCP";  Name="WebSocket Signal"},
        @{Port=21119; Proto="TCP";  Name="WebSocket Relay"},
        @{Port=5000;  Proto="TCP";  Name="Web Console"},
        @{Port=5443;  Proto="TCP";  Name="Web Console HTTPS"},
        @{Port=[int]$script:GO_API_PORT; Proto="TCP";  Name="Go API (default, direct)"},
        @{Port=[int]$script:CLIENT_API_PORT; Proto="TCP";  Name="RustDesk client API (backward-compat proxy)"}
    )
    
    $missingRules = @()
    
    foreach ($p in $requiredPorts) {
        $rules = Get-NetFirewallRule -Direction Inbound -Enabled True -ErrorAction SilentlyContinue | 
            Where-Object { $_.Action -eq 'Allow' } |
            Get-NetFirewallPortFilter -ErrorAction SilentlyContinue | 
            Where-Object { $_.LocalPort -eq $p.Port -and ($_.Protocol -eq $p.Proto -or $_.Protocol -eq 'Any') }
        
        if ($rules) {
            Write-Host "  Port $($p.Port)/$($p.Proto) ($($p.Name)): " -NoNewline
            Write-Host "ALLOWED" -ForegroundColor Green
        } else {
            Write-Host "  Port $($p.Port)/$($p.Proto) ($($p.Name)): " -NoNewline
            Write-Host "NO RULE" -ForegroundColor Red
            $missingRules += $p
        }
    }
    
    return $missingRules
}

function Configure-Firewall {
    param([array]$MissingRules = @())
    
    if ($MissingRules.Count -eq 0) {
        # Check all required ports
        $requiredPorts = @(
            @{Port=21115; Proto="TCP";  Name="BetterDesk NAT Test"},
            @{Port=21116; Proto="TCP";  Name="BetterDesk ID Server TCP"},
            @{Port=21116; Proto="UDP";  Name="BetterDesk ID Server UDP"},
            @{Port=21117; Proto="TCP";  Name="BetterDesk Relay Server"},
            @{Port=21118; Proto="TCP";  Name="BetterDesk WebSocket Signal"},
            @{Port=21119; Proto="TCP";  Name="BetterDesk WebSocket Relay"},
            @{Port=5000;  Proto="TCP";  Name="BetterDesk Web Console"},
            @{Port=5443;  Proto="TCP";  Name="BetterDesk Console HTTPS"},
            @{Port=[int]$script:GO_API_PORT; Proto="TCP";  Name="BetterDesk Go API (default)"},
            @{Port=[int]$script:CLIENT_API_PORT; Proto="TCP";  Name="BetterDesk client API (compat proxy)"}
        )
        
        foreach ($p in $requiredPorts) {
            $rules = Get-NetFirewallRule -Direction Inbound -Enabled True -ErrorAction SilentlyContinue | 
                Where-Object { $_.Action -eq 'Allow' } |
                Get-NetFirewallPortFilter -ErrorAction SilentlyContinue | 
                Where-Object { $_.LocalPort -eq $p.Port -and ($_.Protocol -eq $p.Proto -or $_.Protocol -eq 'Any') }
            
            if (-not $rules) {
                $MissingRules += $p
            }
        }
    }
    
    if ($MissingRules.Count -eq 0) {
        Print-Success "All firewall rules are already configured"
        return $true
    }
    
    Print-Info "Creating $($MissingRules.Count) missing firewall rules..."
    $created = 0
    
    foreach ($p in $MissingRules) {
        $ruleName = "BetterDesk - $($p.Name)"
        try {
            New-NetFirewallRule -DisplayName $ruleName `
                -Direction Inbound -Action Allow `
                -Protocol $p.Proto -LocalPort $p.Port `
                -Profile Any -ErrorAction Stop | Out-Null
            Print-Success "  Created rule: $ruleName (port $($p.Port)/$($p.Proto))"
            $created++
        } catch {
            Print-Error "  Failed to create rule: $ruleName - $($_.Exception.Message)"
        }
    }
    
    Print-Info "$created/$($MissingRules.Count) firewall rules created"
    return ($created -eq $MissingRules.Count)
}

function Do-Diagnostics {
    Print-Header
    Write-Host "========== DIAGNOSTICS ==========" -ForegroundColor White
    Write-Host ""
    
    Detect-Installation
    Print-Status
    
    Write-Host ""
    Write-Host "=== Process Information ===" -ForegroundColor White
    Write-Host ""
    
    $serverProc = Get-Process -Name "betterdesk-server" -ErrorAction SilentlyContinue
    if ($serverProc) {
        Write-Host "  BetterDesk Server: PID $($serverProc.Id), Memory $('{0:N0}' -f ($serverProc.WorkingSet64/1MB)) MB" -ForegroundColor Green
    } else {
        # Fallback: check legacy hbbs/hbbr processes
        $hbbsProc = Get-Process -Name "hbbs" -ErrorAction SilentlyContinue
        $hbbrProc = Get-Process -Name "hbbr" -ErrorAction SilentlyContinue
        if ($hbbsProc -or $hbbrProc) {
            if ($hbbsProc) {
                Write-Host "  HBBS (legacy): PID $($hbbsProc.Id), Memory $('{0:N0}' -f ($hbbsProc.WorkingSet64/1MB)) MB" -ForegroundColor Yellow
            }
            if ($hbbrProc) {
                Write-Host "  HBBR (legacy): PID $($hbbrProc.Id), Memory $('{0:N0}' -f ($hbbrProc.WorkingSet64/1MB)) MB" -ForegroundColor Yellow
            }
            Print-Warning "Legacy Rust processes detected. Consider migrating to Go server."
        } else {
            Write-Host "  BetterDesk Server: Not running" -ForegroundColor Red
        }
    }
    
    Write-Host ""
    Write-Host "=== Database Statistics ===" -ForegroundColor White
    Write-Host ""
    
    if (Test-Path $script:DB_PATH) {
        $fileInfo = Get-Item $script:DB_PATH
        Write-Host "  Size: $('{0:N2}' -f ($fileInfo.Length/1KB)) KB"
        Write-Host "  Modified: $($fileInfo.LastWriteTime)"
        
        # Get database counts
        $pythonScript = @"
import sqlite3
db_path = r'$($script:DB_PATH)'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

try:
    cursor.execute("SELECT COUNT(*) FROM peer WHERE is_deleted = 0")
    devices = cursor.fetchone()[0]
    print(f"  Devices: {devices}")
except:
    print("  Devices: Unable to query")

try:
    cursor.execute("SELECT COUNT(*) FROM peer WHERE status = 1 AND is_deleted = 0")
    online = cursor.fetchone()[0]
    print(f"  Online:  {online}")
except:
    pass

try:
    cursor.execute("SELECT COUNT(*) FROM users")
    users = cursor.fetchone()[0]
    print(f"  Users:   {users}")
except:
    pass

conn.close()
"@
        $pythonScript | python
    } else {
        Write-Host "  Database does not exist"
    }
    
    # --- Port diagnostics ---
    Write-Host ""
    Write-Host "=== Port Diagnostics ===" -ForegroundColor White
    Write-Host ""
    
    $portDefs = @(
        @{Port=[int]$script:GO_API_PORT; Proto="TCP"; Expected="betterdesk-server"; Desc="Go API (default)"},
        @{Port=[int]$script:CLIENT_API_PORT; Proto="TCP"; Expected="node"; Desc="Client API (backward-compat proxy)"},
        @{Port=21115; Proto="TCP"; Expected="betterdesk-server"; Desc="NAT Test"},
        @{Port=21116; Proto="TCP"; Expected="betterdesk-server"; Desc="ID Server (TCP)"},
        @{Port=21116; Proto="UDP"; Expected="betterdesk-server"; Desc="ID Server (UDP)"},
        @{Port=21117; Proto="TCP"; Expected="betterdesk-server"; Desc="Relay Server"},
        @{Port=5000;  Proto="TCP"; Expected="node"; Desc="Web Console"}
    )
    
    $portIssues = 0
    foreach ($pd in $portDefs) {
        $status = Check-PortStatus -Port $pd.Port -Protocol $pd.Proto -ExpectedService $pd.Expected
        
        $label = "  Port $($pd.Port)/$($pd.Proto) ($($pd.Desc)):"
        
        if ($status.Listening) {
            if ($status.Conflict) {
                Write-Host "$label " -NoNewline
                Write-Host "CONFLICT - used by $($status.ProcessName) (PID $($status.PID))" -ForegroundColor Red
                $portIssues++
            } else {
                Write-Host "$label " -NoNewline
                Write-Host "OK - $($status.ProcessName) (PID $($status.PID))" -ForegroundColor Green
            }
        } else {
            Write-Host "$label " -NoNewline
            Write-Host "NOT LISTENING" -ForegroundColor Yellow
        }
    }
    
    if ($portIssues -gt 0) {
        Write-Host ""
        Print-Warning "$portIssues port conflict(s) detected!"
        Write-Host "  Tip: Stop conflicting processes or change ports in configuration" -ForegroundColor Yellow
        Write-Host "  Common fix: Ensure no other app uses ports 21115-21117, 5000, $($script:GO_API_PORT), $($script:CLIENT_API_PORT)" -ForegroundColor Yellow
    }
    
    # --- Firewall diagnostics ---
    $missingRules = Check-FirewallRules
    
    if ($missingRules -and $missingRules.Count -gt 0) {
        Write-Host ""
        Print-Warning "$($missingRules.Count) firewall rule(s) missing!"
        Write-Host "  Use option 'F' from diagnostics menu to auto-configure firewall" -ForegroundColor Yellow
    }
    
    # --- API connectivity test ---
    Write-Host ""
    Write-Host "=== API Connectivity ===" -ForegroundColor White
    Write-Host ""
    
    $apiUrl = "http://127.0.0.1:$($script:API_PORT)/api/server-info"
    try {
        $response = Invoke-WebRequest -Uri $apiUrl -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Host "  Server API ($($script:API_PORT)): " -NoNewline
        Write-Host "OK (HTTP $($response.StatusCode))" -ForegroundColor Green
    } catch {
        Write-Host "  Server API ($($script:API_PORT)): " -NoNewline
        Write-Host "UNREACHABLE" -ForegroundColor Red
    }
    
    $consoleUrl = "http://127.0.0.1:5000/health"
    try {
        $response = Invoke-WebRequest -Uri $consoleUrl -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Host "  Web Console (5000):   " -NoNewline
        Write-Host "OK (HTTP $($response.StatusCode))" -ForegroundColor Green
    } catch {
        Write-Host "  Web Console (5000):   " -NoNewline
        Write-Host "UNREACHABLE" -ForegroundColor Red
    }
    
    # --- Diagnostics sub-menu ---
    Write-Host ""
    $items = @(
        "Configure firewall rules`tAuto-create any missing rules",
        "Test port connectivity`tProbe ports from outside",
        "Back`tReturn to the main menu"
    )
    $returns = @("F", "P", "0")
    Invoke-MenuChoose -Title "Diagnostics Actions" -Subtitle "Optional follow-up checks" -Items $items -Returns $returns
    $subChoice = $script:MENU_CHOICE
    
    switch ($subChoice) {
        "F" {
            Write-Host ""
            Configure-Firewall -MissingRules $missingRules
            Press-Enter
        }
        "P" {
            Write-Host ""
            Write-Host "=== External Port Test ===" -ForegroundColor White
            Write-Host ""
            $serverIP = Get-PublicIP
            Print-Info "Public IP: $serverIP"
            Print-Info "Testing external port accessibility... (this may take a moment)"
            Write-Host ""
            
            foreach ($port in @(21115, 21116, 21117)) {
                Write-Host "  Port ${port}: " -NoNewline
                try {
                    $tcp = New-Object System.Net.Sockets.TcpClient
                    $result = $tcp.BeginConnect($serverIP, $port, $null, $null)
                    $success = $result.AsyncWaitHandle.WaitOne(3000)
                    if ($success -and $tcp.Connected) {
                        Write-Host "REACHABLE" -ForegroundColor Green
                    } else {
                        Write-Host "BLOCKED/UNREACHABLE" -ForegroundColor Red
                    }
                    $tcp.Close()
                } catch {
                    Write-Host "BLOCKED/UNREACHABLE" -ForegroundColor Red
                }
            }
            Press-Enter
        }
        default { return }
    }
}

#===============================================================================
# Uninstall Function
#===============================================================================

function Do-Uninstall {
    Print-Header
    Write-Host "========== UNINSTALL ==========" -ForegroundColor Red
    Write-Host ""
    
    Print-Warning "This operation will remove BetterDesk Console!"
    Write-Host ""
    
    if (-not (Confirm-Action "Are you sure you want to continue?")) {
        return
    }
    
    if (Confirm-Action "Create backup before uninstall?") {
        Do-BackupSilent
    }
    
    Print-Step "Stopping services..."
    Stop-AllServices
    
    Print-Step "Removing services..."
    
    # Remove Windows services (NSSM)
    $nssmPath = Get-Command nssm -ErrorAction SilentlyContinue
    if ($nssmPath) {
        $nssm = if ($nssmPath -is [System.Management.Automation.ApplicationInfo]) { $nssmPath.Source } else { $nssmPath }
        & $nssm remove $script:HBBS_SERVICE confirm 2>$null
        & $nssm remove $script:HBBR_SERVICE confirm 2>$null
        & $nssm remove $script:CONSOLE_SERVICE confirm 2>$null
    }
    
    # Remove scheduled tasks
    Unregister-ScheduledTask -TaskName $script:HBBS_SERVICE -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $script:HBBR_SERVICE -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $script:CONSOLE_SERVICE -Confirm:$false -ErrorAction SilentlyContinue
    
    if (Confirm-Action "Remove installation files ($script:RUSTDESK_PATH)?") {
        Remove-Item -Path $script:RUSTDESK_PATH -Recurse -Force -ErrorAction SilentlyContinue
        Print-Info "Removed: $script:RUSTDESK_PATH"
    }
    
    if (Confirm-Action "Remove Web Console ($script:CONSOLE_PATH)?") {
        Remove-Item -Path $script:CONSOLE_PATH -Recurse -Force -ErrorAction SilentlyContinue
        Print-Info "Removed: $script:CONSOLE_PATH"
    }
    
    Print-Success "BetterDesk has been uninstalled"
    Press-Enter
}

#===============================================================================
# Path Configuration
#===============================================================================

function Configure-Paths {
    Print-Header
    Write-Host ""
    Write-Host "=== Path Configuration ===" -ForegroundColor White
    Write-Host ""
    Write-Host "  Current RustDesk path: " -NoNewline; Write-Host $script:RUSTDESK_PATH -ForegroundColor Cyan
    Write-Host "  Current Console path:  " -NoNewline; Write-Host $script:CONSOLE_PATH -ForegroundColor Cyan
    Write-Host "  Database path:         " -NoNewline; Write-Host $script:DB_PATH -ForegroundColor Cyan
    Write-Host ""
    
    $items = @(
        "Auto-detect paths`tProbe for an existing installation",
        "Set server path`tEnter the BetterDesk server path",
        "Set console path`tEnter the web console path",
        "Reset to defaults`tRestore the default paths",
        "Back`tReturn to the main menu"
    )
    $returns = @("1", "2", "3", "4", "0")
    Invoke-MenuChoose -Title "Path Configuration" -Subtitle "Server: $script:RUSTDESK_PATH" -Items $items -Returns $returns
    $choice = $script:MENU_CHOICE
    
    switch ($choice) {
        "1" {
            $script:RUSTDESK_PATH = ""
            $script:CONSOLE_PATH = ""
            Auto-DetectPaths
            Press-Enter
            Configure-Paths
        }
        "2" {
            Write-Host ""
            $newPath = Read-Host "Enter RustDesk server path (e.g., C:\BetterDesk)"
            if ($newPath) {
                if (Test-Path $newPath) {
                    $script:RUSTDESK_PATH = $newPath
                    $script:DB_PATH = "$script:RUSTDESK_PATH\db_v2.sqlite3"
                    Print-Success "RustDesk path set to: $script:RUSTDESK_PATH"
                } else {
                    Print-Warning "Directory does not exist: $newPath"
                    if (Confirm-Action "Create this directory?") {
                        New-Item -ItemType Directory -Path $newPath -Force | Out-Null
                        $script:RUSTDESK_PATH = $newPath
                        $script:DB_PATH = "$script:RUSTDESK_PATH\db_v2.sqlite3"
                        Print-Success "Created and set RustDesk path: $script:RUSTDESK_PATH"
                    }
                }
            }
            Press-Enter
            Configure-Paths
        }
        "3" {
            Write-Host ""
            $newPath = Read-Host "Enter Console path (e.g., C:\BetterDeskConsole)"
            if ($newPath) {
                if (Test-Path $newPath) {
                    $script:CONSOLE_PATH = $newPath
                    Print-Success "Console path set to: $script:CONSOLE_PATH"
                } else {
                    Print-Warning "Directory does not exist: $newPath"
                    if (Confirm-Action "Create this directory?") {
                        New-Item -ItemType Directory -Path $newPath -Force | Out-Null
                        $script:CONSOLE_PATH = $newPath
                        Print-Success "Created and set Console path: $script:CONSOLE_PATH"
                    }
                }
            }
            Press-Enter
            Configure-Paths
        }
        "4" {
            $script:RUSTDESK_PATH = "C:\BetterDesk"
            $script:CONSOLE_PATH = "C:\BetterDeskConsole"
            $script:DB_PATH = "$script:RUSTDESK_PATH\db_v2.sqlite3"
            Print-Success "Paths reset to defaults"
            Press-Enter
            Configure-Paths
        }
        "0" { return }
        default {
            Print-Error "Invalid option"
            Start-Sleep -Seconds 1
            Configure-Paths
        }
    }
}

#===============================================================================
# Build Functions
#===============================================================================

function Do-Build {
    Print-Header
    $items = @(
        "Rebuild & deploy Go server`tCompile, stop, replace, start",
        "Compile Go server only`tBuild without deploying",
        "Build legacy Rust binaries`tArchived hbbs/hbbr",
        "Back`tReturn to the main menu"
    )
    $returns = @("1", "2", "3", "0")
    Invoke-MenuChoose -Title "Build & Deploy" -Subtitle "Compile the BetterDesk server" -Items $items -Returns $returns
    $buildChoice = $script:MENU_CHOICE
    if ([string]::IsNullOrEmpty($buildChoice)) { $buildChoice = "1" }

    switch ($buildChoice) {
        "1" { Do-RebuildGoServer }
        "2" { Do-CompileGoOnly }
        "3" { Do-BuildLegacyRust }
        "0" { return }
        default { Print-Warning "Invalid option"; Start-Sleep -Seconds 1 }
    }
}

# Rebuild & deploy Go server: compile -> backup -> stop -> replace -> start -> verify
function Do-RebuildGoServer {
    Print-Header
    Write-Host "========== REBUILD & DEPLOY GO SERVER ==========" -ForegroundColor White
    Write-Host ""

    Detect-Installation

    if ($script:INSTALL_STATUS -eq "none") {
        Print-Warning "BetterDesk is not installed. Binary will be compiled but not deployed."
        if (-not (Confirm-Action "Continue with compilation only?")) {
            Press-Enter
            return
        }
        Do-CompileGoOnly
        return
    }

    # Step 1: Compile
    Print-Step "[1/5] Compiling Go server from source..."
    if (-not (Compile-GoServer)) {
        Print-Error "Compilation failed - aborting. Current installation is untouched."
        Press-Enter
        return
    }

    $newBinary = Join-Path $script:GO_SERVER_SOURCE "betterdesk-server.exe"
    if (-not (Test-Path $newBinary)) {
        Print-Error "Compiled binary not found at $newBinary"
        Press-Enter
        return
    }

    # Step 2: Backup current binary
    Print-Step "[2/5] Backing up current binary..."
    $installedBinary = Join-Path $script:RUSTDESK_PATH "betterdesk-server.exe"
    $ts = Get-Date -Format "yyyyMMdd_HHmmss"
    $backupPath = "${installedBinary}.backup.${ts}"
    if (Test-Path $installedBinary) {
        Copy-Item -Path $installedBinary -Destination $backupPath -Force
        Print-Info "Backup: $backupPath"
    } else {
        Print-Info "No existing binary to backup"
    }

    # Step 3: Stop services
    Print-Step "[3/5] Stopping services..."
    Stop-AllServices

    # Step 4: Replace binary
    Print-Step "[4/5] Deploying new binary..."
    if (-not (Test-Path $script:RUSTDESK_PATH)) {
        New-Item -ItemType Directory -Path $script:RUSTDESK_PATH -Force | Out-Null
    }

    # Verify file is not locked
    if (Test-Path $installedBinary) {
        try {
            $stream = [System.IO.File]::Open($installedBinary, 'Open', 'ReadWrite', 'None')
            $stream.Close()
        } catch {
            Print-Warning "File is locked, waiting..."
            Start-Sleep -Seconds 3
            Get-Process -Name "betterdesk-server" -ErrorAction SilentlyContinue | Stop-Process -Force
            Start-Sleep -Seconds 2
        }
    }

    Copy-Item -Path $newBinary -Destination $installedBinary -Force
    $size = [math]::Round((Get-Item $installedBinary).Length / 1MB, 2)
    Print-Success "Deployed: $installedBinary ($size MB)"

    # Step 5: Start services and verify
    Print-Step "[5/5] Starting services..."
    Start-ServicesWithVerification

    # Verify
    Start-Sleep -Seconds 3
    $serverProcess = Get-Process -Name "betterdesk-server" -ErrorAction SilentlyContinue
    if ($serverProcess) {
        Write-Host ""
        Print-Success "Go server rebuilt and deployed successfully!"
    } else {
        Print-Error "Service failed to start after rebuild!"
        Write-Host ""
        Write-Host "Rolling back to previous binary..." -ForegroundColor Yellow
        if (Test-Path $backupPath) {
            # Stop again
            Get-Process -Name "betterdesk-server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
            Copy-Item -Path $backupPath -Destination $installedBinary -Force
            Start-Services
            Start-Sleep -Seconds 3
            $rollbackProcess = Get-Process -Name "betterdesk-server" -ErrorAction SilentlyContinue
            if ($rollbackProcess) {
                Print-Success "Rollback successful - previous binary restored"
            } else {
                Print-Error "Rollback also failed. Check event log for details."
            }
        } else {
            Print-Error "No backup to rollback to."
        }
    }

    Press-Enter
}

# Compile Go server only (no deployment)
function Do-CompileGoOnly {
    Print-Header
    Write-Host "========== COMPILE GO SERVER ==========" -ForegroundColor White
    Write-Host ""

    if (-not (Compile-GoServer)) {
        Print-Error "Compilation failed"
        Press-Enter
        return
    }

    $newBinary = Join-Path $script:GO_SERVER_SOURCE "betterdesk-server.exe"
    $size = [math]::Round((Get-Item $newBinary).Length / 1MB, 2)
    Print-Success "Binary compiled: $newBinary ($size MB)"
    Print-Info "Use option 7 -> 1 to deploy it, or copy manually."

    Press-Enter
}

# Legacy Rust build (archived - hbbs/hbbr)
function Do-BuildLegacyRust {
    Print-Header
    Write-Host "========== BUILD LEGACY RUST BINARIES ==========" -ForegroundColor White
    Write-Host ""
    Print-Warning "Legacy Rust binaries (hbbs/hbbr) are archived."
    Print-Info "The Go server is the current architecture."
    Write-Host ""
    if (-not (Confirm-Action "Continue with legacy Rust build anyway?")) {
        return
    }

    # Check Rust
    $cargoCmd = Get-Command cargo -ErrorAction SilentlyContinue
    if (-not $cargoCmd) {
        Print-Error "Rust is not installed!"
        Print-Info "Install from: https://rustup.rs"
        if (Confirm-Action "Open Rust installation page?") {
            Start-Process "https://rustup.rs"
        }
        Press-Enter
        return
    }

    $rustVersion = rustc --version
    Print-Info "Rust: $rustVersion"
    Write-Host ""

    $buildDir = Join-Path $env:TEMP "betterdesk_build_$((Get-Date).Ticks)"
    New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

    Push-Location $buildDir

    try {
        Print-Step "Downloading RustDesk Server sources..."
        git clone --depth 1 --branch 1.1.14 https://github.com/rustdesk/rustdesk-server.git
        Set-Location "rustdesk-server"
        git submodule update --init --recursive

        Print-Step "Applying BetterDesk modifications..."

        $srcDir = Join-Path $script:ScriptDir "hbbs-patch-v2\src"
        if (Test-Path $srcDir) {
            Copy-Item -Path "$srcDir\main.rs" -Destination "src\main.rs" -Force
            Copy-Item -Path "$srcDir\http_api.rs" -Destination "src\http_api.rs" -Force
            Copy-Item -Path "$srcDir\database.rs" -Destination "src\database.rs" -Force
            Copy-Item -Path "$srcDir\peer.rs" -Destination "src\peer.rs" -Force -ErrorAction SilentlyContinue
            Copy-Item -Path "$srcDir\rendezvous_server.rs" -Destination "src\rendezvous_server.rs" -Force -ErrorAction SilentlyContinue
        } else {
            Print-Error "Source modifications not found: $srcDir"
            return
        }

        Print-Step "Compiling (may take several minutes)..."
        cargo build --release

        Print-Step "Copying binaries..."

        $outputDir = Join-Path $script:ScriptDir "hbbs-patch-v2"
        Copy-Item -Path "target\release\hbbs.exe" -Destination "$outputDir\hbbs-windows-x86_64.exe" -Force
        Copy-Item -Path "target\release\hbbr.exe" -Destination "$outputDir\hbbr-windows-x86_64.exe" -Force

        Print-Success "Legacy Rust compilation completed!"
        Print-Info "Binaries saved in: $outputDir"

    } finally {
        Pop-Location
        Remove-Item -Path $buildDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    Press-Enter
}

#===============================================================================
# SSL Certificate Configuration
#===============================================================================

function Do-ConfigureSSL {
    Print-Header
    Write-Host "========== SSL CERTIFICATE CONFIGURATION ==========" -ForegroundColor White
    Write-Host ""
    
    $envFile = Join-Path $script:CONSOLE_PATH ".env"
    if (-not (Test-Path $envFile)) {
        Print-Error "Node.js console .env not found at $envFile"
        Print-Info "Please install BetterDesk first (option 1)"
        Press-Enter
        return
    }
    
    $items = @(
        "Let's Encrypt`tACME certificate (manual on Windows)",
        "Custom certificate`tProvide your own cert + key files",
        "Self-signed certificate`tQuick HTTPS for testing",
        "Disable SSL`tRevert the panel back to HTTP",
        "Enterprise TLS`tPanel + signal + relay (API stays HTTP)",
        "Back`tReturn to the main menu"
    )
    $returns = @("1", "2", "3", "4", "5", "0")
    Invoke-MenuChoose -Title "SSL Certificate Configuration" -Subtitle "Enables HTTPS for the admin panel" -Items $items -Returns $returns
    $sslChoice = $script:MENU_CHOICE
    if ([string]::IsNullOrEmpty($sslChoice)) { $sslChoice = "3" }
    
    $envContent = Get-Content $envFile -Raw
    $sslDir = Join-Path $script:RUSTDESK_PATH "ssl"
    
    switch ($sslChoice) {
        "0" { return }
        "1" {
            # Let's Encrypt
            Print-Warning "Let's Encrypt is not yet supported on Windows via this script."
            Print-Info "Please use Certbot manually or option 2 (custom certificate)."
            Press-Enter
            return
        }
        "2" {
            # Custom certificate
            Write-Host ""
            $certPath = Read-Host "Path to certificate file (PEM)"
            $keyPath = Read-Host "Path to private key file (PEM)"
            $caPath = Read-Host "Path to CA bundle (optional, press Enter to skip)"
            
            if (-not (Test-Path $certPath)) {
                Print-Error "Certificate file not found: $certPath"
                Press-Enter
                return
            }
            if (-not (Test-Path $keyPath)) {
                Print-Error "Key file not found: $keyPath"
                Press-Enter
                return
            }
            
            $envContent = $envContent -replace 'HTTPS_ENABLED=.*', 'HTTPS_ENABLED=true'
            $envContent = $envContent -replace 'SSL_CERT_PATH=.*', "SSL_CERT_PATH=$certPath"
            $envContent = $envContent -replace 'SSL_KEY_PATH=.*', "SSL_KEY_PATH=$keyPath"
            if (-not [string]::IsNullOrEmpty($caPath) -and (Test-Path $caPath)) {
                $envContent = $envContent -replace 'SSL_CA_PATH=.*', "SSL_CA_PATH=$caPath"
            }
            $envContent = $envContent -replace 'HTTP_REDIRECT_HTTPS=.*', 'HTTP_REDIRECT_HTTPS=true'
            if ($envContent -match 'RUSTDESK_API_TLS=') {
                $envContent = $envContent -replace 'RUSTDESK_API_TLS=.*', 'RUSTDESK_API_TLS=true'
            } else {
                $envContent = $envContent.TrimEnd() + "`nRUSTDESK_API_TLS=true`n"
            }
            
            Set-Content $envFile -Value $envContent -NoNewline
            Print-Success "Custom SSL certificate configured"
        }
        "3" {
            # Self-signed with full SANs
            New-Item -ItemType Directory -Path $sslDir -Force | Out-Null
            
            $certPath = Join-Path $sslDir "betterdesk.crt"
            $keyPath = Join-Path $sslDir "betterdesk.key"
            
            Write-Host ""
            $certDomain = Read-Host "Enter domain name (optional, press Enter to skip)"
            
            # Detect IPs
            $serverIp = Get-PublicIP
            $lanIp = ""
            try {
                $lanIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { 
                    $_.IPAddress -notmatch '^127\.' -and $_.IPAddress -notmatch '^169\.254\.' 
                } | Select-Object -First 1).IPAddress
            } catch {
                $lanIp = [System.Net.Dns]::GetHostAddresses($env:COMPUTERNAME) | 
                    Where-Object { $_.AddressFamily -eq 'InterNetwork' -and $_.IPAddressToString -notmatch '^127\.' } | 
                    Select-Object -First 1 -ExpandProperty IPAddressToString
            }
            
            # Build SAN list
            $sanList = "IP:$serverIp,IP:127.0.0.1,DNS:localhost"
            if ($lanIp -and $lanIp -ne $serverIp) {
                $sanList = "$sanList,IP:$lanIp"
            }
            if ($certDomain) {
                $sanList = "DNS:$certDomain,$sanList"
            }
            
            $cn = if ($certDomain) { $certDomain } else { $serverIp }
            
            Print-Step "Generating self-signed certificate..."
            Print-Info "SANs: $sanList"
            
            # Use openssl if available, otherwise PowerShell
            $openssl = Get-Command openssl -ErrorAction SilentlyContinue
            if ($openssl) {
                $sanArg = "subjectAltName=$sanList"
                & openssl req -x509 -nodes -days 3650 -newkey rsa:2048 `
                    -keyout $keyPath -out $certPath `
                    -subj "/CN=$cn/O=BetterDesk/C=PL" `
                    -addext $sanArg 2>&1 | Out-Null
                    
                if (-not (Test-Path $certPath)) {
                    # Fallback for older openssl without -addext
                    & openssl req -x509 -nodes -days 3650 -newkey rsa:2048 `
                        -keyout $keyPath -out $certPath `
                        -subj "/CN=$cn/O=BetterDesk/C=PL" 2>&1 | Out-Null
                }
            } else {
                # PowerShell self-signed cert
                $dnsNames = @("localhost")
                if ($certDomain) { $dnsNames += $certDomain }
                
                $cert = New-SelfSignedCertificate -DnsName $dnsNames `
                    -CertStoreLocation "cert:\LocalMachine\My" `
                    -NotAfter (Get-Date).AddYears(10) `
                    -KeyExportPolicy Exportable
                    
                # Export as PFX then convert to PEM via openssl if available
                $pfxPath = Join-Path $sslDir "betterdesk.pfx"
                $certBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx)
                [System.IO.File]::WriteAllBytes($pfxPath, $certBytes)
                
                Print-Warning "Generated PFX certificate at $pfxPath"
                Print-Warning "For full PEM support, install OpenSSL for Windows."
                $certPath = $pfxPath
                $keyPath = $pfxPath
            }
            
            $envContent = $envContent -replace 'HTTPS_ENABLED=.*', 'HTTPS_ENABLED=true'
            $envContent = $envContent -replace 'SSL_CERT_PATH=.*', "SSL_CERT_PATH=$certPath"
            $envContent = $envContent -replace 'SSL_KEY_PATH=.*', "SSL_KEY_PATH=$keyPath"
            $envContent = $envContent -replace 'HTTP_REDIRECT_HTTPS=.*', 'HTTP_REDIRECT_HTTPS=true'
            if ($envContent -match 'RUSTDESK_API_TLS=') {
                $envContent = $envContent -replace 'RUSTDESK_API_TLS=.*', 'RUSTDESK_API_TLS=false'
            } else {
                $envContent = $envContent.TrimEnd() + "`nRUSTDESK_API_TLS=false`n"
            }
            
            # Configure NODE_EXTRA_CA_CERTS for self-signed
            if ($envContent -match 'NODE_EXTRA_CA_CERTS=') {
                $envContent = $envContent -replace 'NODE_EXTRA_CA_CERTS=.*', "NODE_EXTRA_CA_CERTS=$certPath"
            } else {
                $envContent = $envContent.TrimEnd() + "`nNODE_EXTRA_CA_CERTS=$certPath`n"
            }
            
            Set-Content $envFile -Value $envContent -NoNewline
            
            # Configure Go server with TLS for signal/relay
            $nssm = Get-Command nssm -ErrorAction SilentlyContinue
            if ($nssm) {
                $goSvcName = $script:SERVER_SERVICE
                try {
                    $goArgs = & nssm get $goSvcName AppParameters 2>$null
                    if ($goArgs) {
                        # Remove old TLS args
                        $goArgs = $goArgs -replace ' -tls-cert [^ ]*', ''
                        $goArgs = $goArgs -replace ' -tls-key [^ ]*', ''
                        $goArgs = $goArgs -replace ' -tls-signal', ''
                        $goArgs = $goArgs -replace ' -tls-relay', ''
                        $goArgs = $goArgs -replace ' -tls-api', ''
                        # Add new TLS args
                        $goArgs = "$goArgs -tls-cert $certPath -tls-key $keyPath -tls-signal -tls-relay"
                        & nssm set $goSvcName AppParameters $goArgs 2>$null
                    }
                } catch { }
            }
            
            Print-Success "Self-signed certificate generated (valid 10 years)"
            Print-Info "Certificate: $certPath"
            if ($lanIp -and $lanIp -ne $serverIp) {
                Print-Info "LAN IP included: $lanIp"
            }
            Print-Warning "Browsers will show security warning. Use Let's Encrypt for public servers."
        }
        "4" {
            # Disable SSL
            $envContent = $envContent -replace 'HTTPS_ENABLED=.*', 'HTTPS_ENABLED=false'
            $envContent = $envContent -replace 'SSL_CERT_PATH=.*', 'SSL_CERT_PATH='
            $envContent = $envContent -replace 'SSL_KEY_PATH=.*', 'SSL_KEY_PATH='
            $envContent = $envContent -replace 'HTTP_REDIRECT_HTTPS=.*', 'HTTP_REDIRECT_HTTPS=false'
            if ($envContent -match 'RUSTDESK_API_TLS=') {
                $envContent = $envContent -replace 'RUSTDESK_API_TLS=.*', 'RUSTDESK_API_TLS=false'
            } else {
                $envContent = $envContent.TrimEnd() + "`nRUSTDESK_API_TLS=false`n"
            }
            
            # Remove TLS args from Go server
            $nssm = Get-Command nssm -ErrorAction SilentlyContinue
            if ($nssm) {
                $goSvcName = $script:SERVER_SERVICE
                try {
                    $goArgs = & nssm get $goSvcName AppParameters 2>$null
                    if ($goArgs) {
                        $goArgs = $goArgs -replace ' -tls-cert [^ ]*', ''
                        $goArgs = $goArgs -replace ' -tls-key [^ ]*', ''
                        $goArgs = $goArgs -replace ' -tls-signal', ''
                        $goArgs = $goArgs -replace ' -tls-relay', ''
                        $goArgs = $goArgs -replace ' -tls-api', ''
                        & nssm set $goSvcName AppParameters $goArgs 2>$null
                    }
                } catch { }
            }
            
            Set-Content $envFile -Value $envContent -NoNewline
            Print-Success "SSL disabled. Running in HTTP mode."
        }
        "5" {
            # Enterprise TLS - HTTPS for panel/signal/relay, Go API remains HTTP
            Print-Header
            Write-Host "========== ENTERPRISE TLS CONFIGURATION ==========" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "  WARNING: Go API :$($script:GO_API_PORT) and compat :$($script:CLIENT_API_PORT) stay HTTP for RustDesk clients." -ForegroundColor Yellow
            Write-Host "  Panel, signal and relay channels can still use TLS." -ForegroundColor Yellow
            Write-Host ""
            
            New-Item -ItemType Directory -Path $sslDir -Force | Out-Null
            
            $certPath = Join-Path $sslDir "betterdesk.crt"
            $keyPath = Join-Path $sslDir "betterdesk.key"
            
            $certDomain = Read-Host "Enter domain name (optional, press Enter to skip)"
            
            # Detect IPs
            $serverIp = Get-PublicIP
            $lanIp = ""
            try {
                $lanIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { 
                    $_.IPAddress -notmatch '^127\.' -and $_.IPAddress -notmatch '^169\.254\.' 
                } | Select-Object -First 1).IPAddress
            } catch { }
            
            # Build comprehensive SAN list
            $sanList = "IP:$serverIp,IP:127.0.0.1,DNS:localhost"
            if ($lanIp -and $lanIp -ne $serverIp) {
                $sanList = "$sanList,IP:$lanIp"
            }
            if ($certDomain) {
                $sanList = "DNS:$certDomain,$sanList"
            }
            
            $cn = if ($certDomain) { $certDomain } else { $serverIp }
            
            Print-Step "Generating Enterprise certificate..."
            Print-Info "SANs: $sanList"
            
            $openssl = Get-Command openssl -ErrorAction SilentlyContinue
            if ($openssl) {
                $sanArg = "subjectAltName=$sanList"
                & openssl req -x509 -nodes -days 3650 -newkey rsa:4096 `
                    -keyout $keyPath -out $certPath `
                    -subj "/CN=$cn/O=BetterDesk Enterprise/C=PL" `
                    -addext $sanArg 2>&1 | Out-Null
                    
                if (-not (Test-Path $certPath)) {
                    & openssl req -x509 -nodes -days 3650 -newkey rsa:4096 `
                        -keyout $keyPath -out $certPath `
                        -subj "/CN=$cn/O=BetterDesk Enterprise/C=PL" 2>&1 | Out-Null
                }
            } else {
                $dnsNames = @("localhost")
                if ($certDomain) { $dnsNames += $certDomain }
                
                $cert = New-SelfSignedCertificate -DnsName $dnsNames `
                    -CertStoreLocation "cert:\LocalMachine\My" `
                    -NotAfter (Get-Date).AddYears(10) `
                    -KeyExportPolicy Exportable `
                    -KeyLength 4096
                    
                $pfxPath = Join-Path $sslDir "betterdesk.pfx"
                $certBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx)
                [System.IO.File]::WriteAllBytes($pfxPath, $certBytes)
                $certPath = $pfxPath
                $keyPath = $pfxPath
                Print-Warning "Generated PFX certificate. Install OpenSSL for PEM format."
            }
            
            # === Configure Node.js Console for HTTPS ===
            $envContent = $envContent -replace 'HTTPS_ENABLED=.*', 'HTTPS_ENABLED=true'
            $envContent = $envContent -replace 'SSL_CERT_PATH=.*', "SSL_CERT_PATH=$certPath"
            $envContent = $envContent -replace 'SSL_KEY_PATH=.*', "SSL_KEY_PATH=$keyPath"
            $envContent = $envContent -replace 'HTTP_REDIRECT_HTTPS=.*', 'HTTP_REDIRECT_HTTPS=true'
            if ($envContent -match 'RUSTDESK_API_TLS=') {
                $envContent = $envContent -replace 'RUSTDESK_API_TLS=.*', 'RUSTDESK_API_TLS=true'
            } else {
                $envContent = $envContent.TrimEnd() + "`nRUSTDESK_API_TLS=true`n"
            }
            
            # Set ALLOW_SELF_SIGNED_CERTS
            if ($envContent -match 'ALLOW_SELF_SIGNED_CERTS=') {
                $envContent = $envContent -replace 'ALLOW_SELF_SIGNED_CERTS=.*', 'ALLOW_SELF_SIGNED_CERTS=true'
            } else {
                $envContent = $envContent.TrimEnd() + "`nALLOW_SELF_SIGNED_CERTS=true`n"
            }
            
            # Configure NODE_EXTRA_CA_CERTS
            if ($envContent -match 'NODE_EXTRA_CA_CERTS=') {
                $envContent = $envContent -replace 'NODE_EXTRA_CA_CERTS=.*', "NODE_EXTRA_CA_CERTS=$certPath"
            } else {
                $envContent = $envContent.TrimEnd() + "`nNODE_EXTRA_CA_CERTS=$certPath`n"
            }
            
            # Keep internal Go API URLs on HTTP for RustDesk client compatibility
            $envContent = $envContent -replace 'HBBS_API_URL=https://localhost', 'HBBS_API_URL=http://localhost'
            $envContent = $envContent -replace 'BETTERDESK_API_URL=https://localhost', 'BETTERDESK_API_URL=http://localhost'
            
            # Set ENTERPRISE_TLS marker
            if ($envContent -match 'ENTERPRISE_TLS=') {
                $envContent = $envContent -replace 'ENTERPRISE_TLS=.*', 'ENTERPRISE_TLS=true'
            } else {
                $envContent = $envContent.TrimEnd() + "`nENTERPRISE_TLS=true`n"
            }
            
            Set-Content $envFile -Value $envContent -NoNewline
            
            # === Configure Go server with TLS for signal + relay only ===
            $nssm = Get-Command nssm -ErrorAction SilentlyContinue
            if ($nssm) {
                $goSvcName = $script:SERVER_SERVICE
                try {
                    $goArgs = & nssm get $goSvcName AppParameters 2>$null
                    if ($goArgs) {
                        # Remove old TLS args
                        $goArgs = $goArgs -replace ' -tls-cert [^ ]*', ''
                        $goArgs = $goArgs -replace ' -tls-key [^ ]*', ''
                        $goArgs = $goArgs -replace ' -tls-signal', ''
                        $goArgs = $goArgs -replace ' -tls-relay', ''
                        $goArgs = $goArgs -replace ' -tls-api', ''
                        $goArgs = $goArgs -replace ' -force-https', ''
                        # Add TLS args without -tls-api
                        $goArgs = "$goArgs -tls-cert $certPath -tls-key $keyPath -tls-signal -tls-relay"
                        & nssm set $goSvcName AppParameters $goArgs 2>$null
                    }
                } catch { }
            }
            
            Print-Success "Enterprise TLS configured successfully!"
            Write-Host ""
            Print-Info "Certificate: $certPath"
            Print-Info "Valid: 10 years (RSA 4096-bit)"
            if ($lanIp -and $lanIp -ne $serverIp) {
                Print-Info "LAN IP: $lanIp"
            }
            Write-Host ""
            Write-Host "  TLS configured for external channels:" -ForegroundColor Yellow
            Print-Info "  - Panel HTTPS: :5443 (or configured port)"
            Print-Info "  - Signal TLS: :21116"
            Print-Info "  - Relay TLS: :21117"
            Print-Info "  - Go API HTTP: :$($script:GO_API_PORT) (compat proxy :$($script:CLIENT_API_PORT))"
            Write-Host ""
            Print-Warning "For browsers/clients, you may need to import $certPath as trusted CA"
        }
        default {
            Print-Warning "Invalid option"
            Press-Enter
            return
        }
    }
    
    # ── Update API URLs in .env when SSL is enabled/disabled ──
    # Go API TLS (--tls-api) is intentionally not enabled by SSL options.
    # RustDesk desktop clients use plain HTTP on :GO_API_PORT or compat :CLIENT_API_PORT.
    $envContent = Get-Content $envFile -Raw
    
    if ($sslChoice -eq "5") {
        # === Enterprise TLS compatibility mode: Go API stays HTTP ===
        Print-Info "Enterprise TLS mode: panel/signal/relay use TLS; Go API stays HTTP"
        $envContent = $envContent -replace 'HBBS_API_URL=https://localhost', 'HBBS_API_URL=http://localhost'
        $envContent = $envContent -replace 'BETTERDESK_API_URL=https://localhost', 'BETTERDESK_API_URL=http://localhost'
        
        # Ensure NSSM service has ALLOW_SELF_SIGNED_CERTS
        $nssm = Get-Command nssm -ErrorAction SilentlyContinue
        if ($nssm) {
            $svcName = $script:CONSOLE_SERVICE
            try {
                $currentEnv = & nssm get $svcName AppEnvironmentExtra 2>$null
                if ($currentEnv) {
                    if ($currentEnv -notmatch 'ALLOW_SELF_SIGNED_CERTS=') {
                        $currentEnv = "$currentEnv`nALLOW_SELF_SIGNED_CERTS=true"
                    }
                    if ($currentEnv -match 'RUSTDESK_API_TLS=') {
                        $currentEnv = $currentEnv -replace 'RUSTDESK_API_TLS=.*', 'RUSTDESK_API_TLS=true'
                    } else {
                        $currentEnv = "$currentEnv`nRUSTDESK_API_TLS=true"
                    }
                    $currentEnv = $currentEnv -replace 'HBBS_API_URL=https://localhost', 'HBBS_API_URL=http://localhost'
                    $currentEnv = $currentEnv -replace 'BETTERDESK_API_URL=https://localhost', 'BETTERDESK_API_URL=http://localhost'
                    & nssm set $svcName AppEnvironmentExtra $currentEnv 2>$null
                }
            } catch { }

            $goSvcName = $script:SERVER_SERVICE
            try {
                $goArgs = & nssm get $goSvcName AppParameters 2>$null
                if ($goArgs) {
                    $goArgs = $goArgs -replace ' -tls-api', ''
                    $goArgs = $goArgs -replace ' -force-https', ''
                    & nssm set $goSvcName AppParameters $goArgs 2>$null
                }
            } catch { }
        }
        
    } elseif ($sslChoice -ne "4") {
        # === Standard SSL (options 1-3): API stays HTTP for RustDesk client compatibility ===
        $envContent = $envContent -replace 'HBBS_API_URL=https://localhost', 'HBBS_API_URL=http://localhost'
        $envContent = $envContent -replace 'BETTERDESK_API_URL=https://localhost', 'BETTERDESK_API_URL=http://localhost'
        
        # For self-signed certs, Node.js needs NODE_EXTRA_CA_CERTS to trust the CA
        $sslCertValue = [regex]::Match($envContent, 'SSL_CERT_PATH=(.+)').Groups[1].Value.Trim()
        if ($sslCertValue -and (Test-Path $sslCertValue -ErrorAction SilentlyContinue)) {
            if ($envContent -match 'NODE_EXTRA_CA_CERTS=') {
                $envContent = $envContent -replace 'NODE_EXTRA_CA_CERTS=.*', "NODE_EXTRA_CA_CERTS=$sslCertValue"
            } else {
                $envContent = $envContent.TrimEnd() + "`nNODE_EXTRA_CA_CERTS=$sslCertValue`n"
            }
            Print-Info "NODE_EXTRA_CA_CERTS set to $sslCertValue"
        }
        
        # Also update NSSM service environment if available
        $nssm = Get-Command nssm -ErrorAction SilentlyContinue
        if ($nssm) {
            $svcName = $script:CONSOLE_SERVICE
            try {
                $currentEnv = & nssm get $svcName AppEnvironmentExtra 2>$null
                if ($currentEnv) {
                    # Ensure API URLs stay HTTP in NSSM service
                    $currentEnv = $currentEnv -replace 'HBBS_API_URL=https://localhost', 'HBBS_API_URL=http://localhost'
                    $currentEnv = $currentEnv -replace 'BETTERDESK_API_URL=https://localhost', 'BETTERDESK_API_URL=http://localhost'
                    $apiTlsMode = if ($sslChoice -eq "3") { 'false' } else { 'true' }
                    if ($currentEnv -match 'RUSTDESK_API_TLS=') {
                        $currentEnv = $currentEnv -replace 'RUSTDESK_API_TLS=.*', "RUSTDESK_API_TLS=$apiTlsMode"
                    } else {
                        $currentEnv = "$currentEnv`nRUSTDESK_API_TLS=$apiTlsMode"
                    }
                    & nssm set $svcName AppEnvironmentExtra $currentEnv 2>$null
                }
            } catch { }
            
            # Remove -tls-api from Go server service (standard SSL doesn't use API TLS)
            $goSvcName = $script:SERVER_SERVICE
            try {
                $goArgs = & nssm get $goSvcName AppParameters 2>$null
                if ($goArgs) {
                    $goArgs = $goArgs -replace ' -tls-api', ''
                    $goArgs = $goArgs -replace ' -force-https', ''
                    & nssm set $goSvcName AppParameters $goArgs 2>$null
                }
            } catch { }
        }
        
        Print-Info "Signal/relay TLS enabled, API stays HTTP (RustDesk client compatibility)"
    } else {
        # === SSL disabled (option 4) — revert API URLs to HTTP ===
        $envContent = $envContent -replace 'HBBS_API_URL=https://localhost', 'HBBS_API_URL=http://localhost'
        $envContent = $envContent -replace 'BETTERDESK_API_URL=https://localhost', 'BETTERDESK_API_URL=http://localhost'
        $envContent = $envContent -replace '(?m)^NODE_EXTRA_CA_CERTS=.*\r?\n?', ''
        $envContent = $envContent -replace '(?m)^ENTERPRISE_TLS=.*\r?\n?', ''
        $envContent = $envContent -replace 'ALLOW_SELF_SIGNED_CERTS=.*', 'ALLOW_SELF_SIGNED_CERTS=false'
        
        # Remove ALL TLS args from Go server service
        $nssm = Get-Command nssm -ErrorAction SilentlyContinue
        if ($nssm) {
            $svcName = $script:CONSOLE_SERVICE
            try {
                $currentEnv = & nssm get $svcName AppEnvironmentExtra 2>$null
                if ($currentEnv) {
                    if ($currentEnv -match 'RUSTDESK_API_TLS=') {
                        $currentEnv = $currentEnv -replace 'RUSTDESK_API_TLS=.*', 'RUSTDESK_API_TLS=false'
                    } else {
                        $currentEnv = "$currentEnv`nRUSTDESK_API_TLS=false"
                    }
                    & nssm set $svcName AppEnvironmentExtra $currentEnv 2>$null
                }
            } catch { }

            $goSvcName = $script:SERVER_SERVICE
            try {
                $goArgs = & nssm get $goSvcName AppParameters 2>$null
                if ($goArgs) {
                    $goArgs = $goArgs -replace ' -tls-cert [^ ]*', ''
                    $goArgs = $goArgs -replace ' -tls-key [^ ]*', ''
                    $goArgs = $goArgs -replace ' -tls-signal', ''
                    $goArgs = $goArgs -replace ' -tls-relay', ''
                    $goArgs = $goArgs -replace ' -tls-api', ''
                    $goArgs = $goArgs -replace ' -force-https', ''
                    & nssm set $goSvcName AppParameters $goArgs 2>$null
                }
            } catch { }
        }
        
        Print-Info "All TLS disabled, API URLs reverted to HTTP"
    }
    
    Set-Content $envFile -Value $envContent -NoNewline
    
    Write-Host ""
    if (Confirm-Action "Restart BetterDesk to apply changes?") {
        $serverService = $script:SERVER_SERVICE
        $consoleService = $script:CONSOLE_SERVICE
        if (Get-Service -Name $serverService -ErrorAction SilentlyContinue) {
            Restart-Service -Name $serverService -Force -ErrorAction SilentlyContinue
        }
        if (Get-Service -Name $consoleService -ErrorAction SilentlyContinue) {
            Restart-Service -Name $consoleService -Force -ErrorAction SilentlyContinue
        }
        Print-Success "BetterDesk services restarted"
    }
    
    Press-Enter
}

#===============================================================================
# HTTP/HTTPS Protocol Toggle
#===============================================================================

function Do-ToggleProtocol {
    Print-Header
    Write-Host "========== PROTOCOL TOGGLE (HTTP / HTTPS) ==========" -ForegroundColor White
    Write-Host ""

    $envFile = Join-Path $script:CONSOLE_PATH ".env"
    $sslDir = Join-Path $script:RUSTDESK_PATH "ssl"

    # Detect current mode from NSSM or .env
    $currentMode = "HTTP"
    $nssmConsole = "BetterDeskConsole"
    try {
        $nssmEnv = (nssm get $nssmConsole AppEnvironmentExtra 2>$null) -join "`n"
        if ($nssmEnv -match "HTTPS_ENABLED=true") {
            $currentMode = "HTTPS"
        }
    } catch {
        if (Test-Path $envFile) {
            $envContent = Get-Content $envFile -Raw
            if ($envContent -match "HTTPS_ENABLED=true") {
                $currentMode = "HTTPS"
            }
        }
    }

    $tlsSignal = "no"
    $tlsRelay = "no"
    $nssmServer = "BetterDeskServer"
    try {
        $serverArgs = nssm get $nssmServer AppParameters 2>$null
        if ($serverArgs -match "-tls-signal") { $tlsSignal = "yes" }
        if ($serverArgs -match "-tls-relay") { $tlsRelay = "yes" }
    } catch {}

    Write-Host "  Current mode: $currentMode" -ForegroundColor White
    Write-Host "  Signal TLS:   $tlsSignal"
    Write-Host "  Relay TLS:    $tlsRelay"
    Write-Host ""
    $items = @(
        "Switch to HTTP`tEverything plain - LAN / testing",
        "Switch to HTTPS`tPanel HTTPS + signal/relay TLS",
        "Back`tReturn to the main menu"
    )
    $returns = @("1", "2", "0")
    Invoke-MenuChoose -Title "Protocol Mode" -Subtitle "Current mode: $currentMode" -Items $items -Returns $returns
    $protoChoice = $script:MENU_CHOICE

    switch ($protoChoice) {
        "1" {
            # --- Switch to HTTP ---
            Write-Host ""
            Print-Step "Switching to HTTP mode..."

            # Update .env
            if (Test-Path $envFile) {
                $content = Get-Content $envFile -Raw
                $content = $content -replace "(?m)^HTTPS_ENABLED=.*$", "HTTPS_ENABLED=false"
                $content = $content -replace "(?m)^RUSTDESK_API_TLS=.*$", "RUSTDESK_API_TLS=false"
                $content = $content -replace "(?m)^ALLOW_SELF_SIGNED_CERTS=.*$", "ALLOW_SELF_SIGNED_CERTS=false"
                $content = $content -replace "(?m)^HBBS_API_URL=https://localhost", "HBBS_API_URL=http://localhost"
                $content = $content -replace "(?m)^BETTERDESK_API_URL=https://localhost", "BETTERDESK_API_URL=http://localhost"
                $content = $content -replace "(?m)^HTTP_REDIRECT_HTTPS=.*$", "HTTP_REDIRECT_HTTPS=false"
                $content = $content -replace "(?m)^NODE_EXTRA_CA_CERTS=.*`n?", ""
                $content = $content -replace "(?m)^ENTERPRISE_TLS=.*`n?", ""
                Set-Content -Path $envFile -Value $content.TrimEnd() -Encoding UTF8
            }

            # Update NSSM console service
            try {
                $env = (nssm get $nssmConsole AppEnvironmentExtra 2>$null) -join "`n"
                $env = $env -replace "HTTPS_ENABLED=true", "HTTPS_ENABLED=false"
                $env = $env -replace "ALLOW_SELF_SIGNED_CERTS=true", "ALLOW_SELF_SIGNED_CERTS=false"
                $env = $env -replace "RUSTDESK_API_TLS=[^\s]+", "RUSTDESK_API_TLS=false"
                $env = $env -replace "HBBS_API_URL=https://localhost", "HBBS_API_URL=http://localhost"
                $env = $env -replace "BETTERDESK_API_URL=https://localhost", "BETTERDESK_API_URL=http://localhost"
                $env = $env -replace "(?m)^NODE_EXTRA_CA_CERTS=.*$", ""
                $env = $env -replace "(?m)^ENTERPRISE_TLS=.*$", ""
                $env = ($env -split "`n" | Where-Object { $_.Trim() -ne "" }) -join "`n"
                nssm set $nssmConsole AppEnvironmentExtra $env 2>$null | Out-Null
            } catch {}

            # Remove TLS args from Go server
            try {
                $args = nssm get $nssmServer AppParameters 2>$null
                $args = $args -replace '\s*-tls-cert\s+[^\s]+', ''
                $args = $args -replace '\s*-tls-key\s+[^\s]+', ''
                $args = $args -replace '\s*-tls-signal', ''
                $args = $args -replace '\s*-tls-relay', ''
                $args = $args -replace '\s*-tls-api', ''
                $args = $args -replace '\s*-force-https', ''
                nssm set $nssmServer AppParameters $args.Trim() 2>$null | Out-Null
            } catch {}

            Print-Success "Switched to HTTP mode"
            Write-Host ""
            Print-Info "  Panel:         HTTP :5000"
            Print-Info "  Signal:        TCP  :21116"
            Print-Info "  Relay:         TCP  :21117"
            Print-Info "  Go API:        HTTP :$($script:GO_API_PORT) (default)"
            Print-Info "  Client API:    HTTP :$($script:CLIENT_API_PORT) (compat proxy)"
            Write-Host ""
            Print-Warning "SSL certificates were NOT deleted (use option C > 4 to remove)"
        }
        "2" {
            # --- Switch to HTTPS ---
            Write-Host ""

            $certFile = Join-Path $sslDir "betterdesk.crt"
            $keyFile = Join-Path $sslDir "betterdesk.key"

            # Check for SSL certificates
            if (-not (Test-Path $certFile) -or -not (Test-Path $keyFile)) {
                Print-Warning "No SSL certificates found at $sslDir"
                Write-Host ""
                $gen = Read-Host "Generate self-signed certificate now? [Y/n]"
                if ($gen -ne "n" -and $gen -ne "N") {
                    if (-not (Test-Path $sslDir)) { New-Item -ItemType Directory -Path $sslDir -Force | Out-Null }

                    $serverIp = try {
                        (Invoke-WebRequest -Uri "https://api.ipify.org" -TimeoutSec 5 -UseBasicParsing).Content.Trim()
                    } catch { "127.0.0.1" }

                    & openssl req -x509 -nodes -days 3650 -newkey rsa:4096 `
                        -keyout $keyFile -out $certFile `
                        -subj "/CN=$serverIp/O=BetterDesk/C=PL" 2>$null

                    if (Test-Path $certFile) {
                        Print-Success "Self-signed certificate generated"
                    } else {
                        Print-Error "Failed to generate certificate (is openssl installed?)"
                        Press-Enter
                        return
                    }
                } else {
                    Print-Error "Cannot enable HTTPS without certificates"
                    Print-Info "Use option C (SSL config) to set up certificates first"
                    Press-Enter
                    return
                }
            }

            Print-Step "Switching to HTTPS mode..."

            # Update .env
            if (Test-Path $envFile) {
                $content = Get-Content $envFile -Raw
                $content = $content -replace "(?m)^HTTPS_ENABLED=.*$", "HTTPS_ENABLED=true"
                $content = $content -replace "(?m)^SSL_CERT_PATH=.*$", "SSL_CERT_PATH=$certFile"
                $content = $content -replace "(?m)^SSL_KEY_PATH=.*$", "SSL_KEY_PATH=$keyFile"
                $content = $content -replace "(?m)^HTTP_REDIRECT_HTTPS=.*$", "HTTP_REDIRECT_HTTPS=true"
                # Keep Go API on HTTP
                $content = $content -replace "(?m)^HBBS_API_URL=https://localhost", "HBBS_API_URL=http://localhost"
                $content = $content -replace "(?m)^BETTERDESK_API_URL=https://localhost", "BETTERDESK_API_URL=http://localhost"
                if ($content -notmatch "ALLOW_SELF_SIGNED_CERTS=") {
                    $content += "`nALLOW_SELF_SIGNED_CERTS=true"
                } else {
                    $content = $content -replace "(?m)^ALLOW_SELF_SIGNED_CERTS=.*$", "ALLOW_SELF_SIGNED_CERTS=true"
                }
                if ($content -notmatch "NODE_EXTRA_CA_CERTS=") {
                    $content += "`nNODE_EXTRA_CA_CERTS=$certFile"
                } else {
                    $content = $content -replace "(?m)^NODE_EXTRA_CA_CERTS=.*$", "NODE_EXTRA_CA_CERTS=$certFile"
                }
                Set-Content -Path $envFile -Value $content.TrimEnd() -Encoding UTF8
            }

            # Update NSSM console service
            try {
                $env = (nssm get $nssmConsole AppEnvironmentExtra 2>$null) -join "`n"
                $env = $env -replace "HTTPS_ENABLED=false", "HTTPS_ENABLED=true"
                if ($env -notmatch "HTTPS_ENABLED=") { $env += "`nHTTPS_ENABLED=true" }
                $env = $env -replace "ALLOW_SELF_SIGNED_CERTS=false", "ALLOW_SELF_SIGNED_CERTS=true"
                if ($env -notmatch "ALLOW_SELF_SIGNED_CERTS=") { $env += "`nALLOW_SELF_SIGNED_CERTS=true" }
                # Go API stays HTTP
                $env = $env -replace "HBBS_API_URL=https://localhost", "HBBS_API_URL=http://localhost"
                $env = $env -replace "BETTERDESK_API_URL=https://localhost", "BETTERDESK_API_URL=http://localhost"
                if ($env -notmatch "NODE_EXTRA_CA_CERTS=") { $env += "`nNODE_EXTRA_CA_CERTS=$certFile" }
                else { $env = $env -replace "(?m)^NODE_EXTRA_CA_CERTS=.*$", "NODE_EXTRA_CA_CERTS=$certFile" }
                $env = ($env -split "`n" | Where-Object { $_.Trim() -ne "" }) -join "`n"
                nssm set $nssmConsole AppEnvironmentExtra $env 2>$null | Out-Null
            } catch {}

            # Add TLS to Go server (signal + relay only, NOT API)
            try {
                $args = nssm get $nssmServer AppParameters 2>$null
                # Remove old TLS args
                $args = $args -replace '\s*-tls-cert\s+[^\s]+', ''
                $args = $args -replace '\s*-tls-key\s+[^\s]+', ''
                $args = $args -replace '\s*-tls-signal', ''
                $args = $args -replace '\s*-tls-relay', ''
                $args = $args -replace '\s*-tls-api', ''
                $args = $args -replace '\s*-force-https', ''
                # Add signal + relay TLS (API stays HTTP)
                $args = "$($args.Trim()) -tls-cert $certFile -tls-key $keyFile -tls-signal -tls-relay"
                nssm set $nssmServer AppParameters $args 2>$null | Out-Null
            } catch {}

            Print-Success "Switched to HTTPS mode"
            Write-Host ""
            Print-Info "  Panel:         HTTPS :5443"
            Print-Info "  Signal:        TLS   :21116"
            Print-Info "  Relay:         TLS   :21117"
            Print-Info "  Go API:        HTTP  :$($script:GO_API_PORT) (default, always HTTP)"
            Print-Info "  Client API:    HTTP  :$($script:CLIENT_API_PORT) (compat proxy)"
        }
        default { return }
    }

    Write-Host ""
    $restart = Read-Host "Restart BetterDesk services now? [Y/n]"
    if ($restart -ne "n" -and $restart -ne "N") {
        try {
            nssm restart $nssmServer 2>$null | Out-Null
            nssm restart $nssmConsole 2>$null | Out-Null
            Start-Sleep -Seconds 2
            Print-Success "BetterDesk services restarted"
            Write-Host ""
            # Quick status check
            $serverStatus = (nssm status $nssmServer 2>$null)
            $consoleStatus = (nssm status $nssmConsole 2>$null)
            if ($serverStatus -match "Running") { Print-Success "Go Server:   running" }
            else { Print-Error "Go Server:   $serverStatus" }
            if ($consoleStatus -match "Running") { Print-Success "Web Console: running" }
            else { Print-Error "Web Console: $consoleStatus" }
        } catch {
            Print-Error "Failed to restart services: $_"
        }
    }

    Press-Enter
}

#===============================================================================
# Database Migration Functions
#===============================================================================

function Do-MigrateDatabase {
    Print-Header
    Write-Host "========== DATABASE MIGRATION ==========" -ForegroundColor White
    Write-Host ""

    # Locate migration binary
    $migrateBin = $null
    $searchPaths = @(
        (Join-Path $script:ScriptDir "betterdesk-server\tools\migrate\migrate.exe"),
        (Join-Path $script:ScriptDir "tools\migrate\migrate.exe"),
        (Join-Path $script:RUSTDESK_PATH "migrate.exe"),
        "C:\BetterDesk\migrate.exe"
    )

    foreach ($p in $searchPaths) {
        if (Test-Path $p) {
            $migrateBin = $p
            break
        }
    }

    if (-not $migrateBin) {
        Print-Error "Migration binary not found!"
        Print-Info "Expected at: $(Join-Path $script:ScriptDir 'betterdesk-server\tools\migrate\migrate.exe')"
        Print-Info "Build it with: cd betterdesk-server; go build -o tools\migrate\migrate.exe ./tools/migrate/"
        Press-Enter
        return
    }

    Print-Info "Migration binary: $migrateBin"
    Write-Host ""
    $items = @(
        "Rust -> Go`tLegacy Rust hbbs database to Go server",
        "Node.js -> Go`tNode.js web console to Go server",
        "SQLite -> PostgreSQL`tBetterDesk Go SQLite to PostgreSQL",
        "PostgreSQL -> SQLite`tPostgreSQL back to SQLite",
        "Backup`tCreate a timestamped SQLite backup",
        "Back`tReturn to the main menu"
    )
    $returns = @("1", "2", "3", "4", "5", "0")
    Invoke-MenuChoose -Title "Database Migration" -Subtitle "Move data between BetterDesk components" -Items $items -Returns $returns
    $migChoice = $script:MENU_CHOICE

    switch ($migChoice) {
        "1" {
            # Rust -> Go
            Write-Host ""
            $defaultSrc = Join-Path $script:RUSTDESK_PATH "db_v2.sqlite3"
            $srcDb = Read-Host "Source Rust database [$defaultSrc]"
            if ([string]::IsNullOrEmpty($srcDb)) { $srcDb = $defaultSrc }

            if (-not (Test-Path $srcDb)) {
                Print-Error "Source database not found: $srcDb"
                Press-Enter
                return
            }

            $dstDb = Read-Host "Destination (SQLite path or postgres:// URI) [new file next to source]"

            Print-Step "Creating backup before migration..."
            & $migrateBin -mode backup -src $srcDb 2>&1 | ForEach-Object { Write-Host $_ }

            Print-Step "Running Rust -> Go migration..."
            if ([string]::IsNullOrEmpty($dstDb)) {
                & $migrateBin -mode rust2go -src $srcDb 2>&1 | ForEach-Object { Write-Host $_ }
            } else {
                & $migrateBin -mode rust2go -src $srcDb -dst $dstDb 2>&1 | ForEach-Object { Write-Host $_ }
            }

            if ($LASTEXITCODE -eq 0) {
                Print-Success "Rust -> Go migration completed successfully!"
            } else {
                Print-Error "Migration failed. Check the output above for details."
            }
        }
        "2" {
            # Node.js -> Go
            Write-Host ""
            $defaultSrc = Join-Path $script:RUSTDESK_PATH "db_v2.sqlite3"
            $defaultAuth = Join-Path $script:CONSOLE_PATH "data\auth.db"

            $srcDb = Read-Host "Source Node.js peer database [$defaultSrc]"
            if ([string]::IsNullOrEmpty($srcDb)) { $srcDb = $defaultSrc }

            if (-not (Test-Path $srcDb)) {
                Print-Error "Source peer database not found: $srcDb"
                Press-Enter
                return
            }

            $authDb = Read-Host "Node.js auth database [$defaultAuth]"
            if ([string]::IsNullOrEmpty($authDb)) { $authDb = $defaultAuth }

            $dstDb = Read-Host "Destination (SQLite path or postgres:// URI) [new file next to source]"

            Print-Step "Creating backup before migration..."
            & $migrateBin -mode backup -src $srcDb 2>&1 | ForEach-Object { Write-Host $_ }
            if (Test-Path $authDb) {
                & $migrateBin -mode backup -src $authDb 2>&1 | ForEach-Object { Write-Host $_ }
            }

            Print-Step "Running Node.js -> Go migration..."
            $args = @("-mode", "nodejs2go", "-src", $srcDb)
            if (Test-Path $authDb) {
                $args += @("-node-auth", $authDb)
            }
            if (-not [string]::IsNullOrEmpty($dstDb)) {
                $args += @("-dst", $dstDb)
            }
            & $migrateBin @args 2>&1 | ForEach-Object { Write-Host $_ }

            if ($LASTEXITCODE -eq 0) {
                Print-Success "Node.js -> Go migration completed successfully!"
            } else {
                Print-Error "Migration failed. Check the output above for details."
            }
        }
        "3" {
            # SQLite -> PostgreSQL
            Write-Host ""
            $defaultSrc = Join-Path $script:RUSTDESK_PATH "db_v2.sqlite3"
            $srcDb = Read-Host "Source SQLite database [$defaultSrc]"
            if ([string]::IsNullOrEmpty($srcDb)) { $srcDb = $defaultSrc }

            if (-not (Test-Path $srcDb)) {
                Print-Error "Source database not found: $srcDb"
                Press-Enter
                return
            }

            $pgUri = Read-Host "PostgreSQL connection URI (postgres://user:pass@host:5432/dbname)"
            if ([string]::IsNullOrEmpty($pgUri)) {
                Print-Error "PostgreSQL URI is required"
                Press-Enter
                return
            }

            Print-Step "Creating backup before migration..."
            & $migrateBin -mode backup -src $srcDb 2>&1 | ForEach-Object { Write-Host $_ }

            Print-Step "Running SQLite -> PostgreSQL migration..."
            & $migrateBin -mode sqlite2pg -src $srcDb -dst $pgUri 2>&1 | ForEach-Object { Write-Host $_ }

            if ($LASTEXITCODE -eq 0) {
                Print-Success "SQLite -> PostgreSQL migration completed successfully!"
                Print-Info "Update your BetterDesk Go server config: DB_URL=$pgUri"
            } else {
                Print-Error "Migration failed. Check the output above for details."
            }
        }
        "4" {
            # PostgreSQL -> SQLite
            Write-Host ""
            $pgUri = Read-Host "PostgreSQL connection URI (postgres://user:pass@host:5432/dbname)"
            if ([string]::IsNullOrEmpty($pgUri)) {
                Print-Error "PostgreSQL URI is required"
                Press-Enter
                return
            }

            $defaultDst = Join-Path $script:RUSTDESK_PATH "db_v2.sqlite3"
            $dstDb = Read-Host "Destination SQLite file [$defaultDst]"
            if ([string]::IsNullOrEmpty($dstDb)) { $dstDb = $defaultDst }

            if (Test-Path $dstDb) {
                Print-Warning "Destination file exists: $dstDb"
                if (-not (Confirm-Action "Overwrite (backup will be created first)?")) {
                    Press-Enter
                    return
                }
                & $migrateBin -mode backup -src $dstDb 2>&1 | ForEach-Object { Write-Host $_ }
            }

            Print-Step "Running PostgreSQL -> SQLite migration..."
            & $migrateBin -mode pg2sqlite -src $pgUri -dst $dstDb 2>&1 | ForEach-Object { Write-Host $_ }

            if ($LASTEXITCODE -eq 0) {
                Print-Success "PostgreSQL -> SQLite migration completed successfully!"
            } else {
                Print-Error "Migration failed. Check the output above for details."
            }
        }
        "5" {
            # Backup
            Write-Host ""
            $defaultSrc = Join-Path $script:RUSTDESK_PATH "db_v2.sqlite3"
            $srcDb = Read-Host "SQLite database to backup [$defaultSrc]"
            if ([string]::IsNullOrEmpty($srcDb)) { $srcDb = $defaultSrc }

            if (-not (Test-Path $srcDb)) {
                Print-Error "Database not found: $srcDb"
                Press-Enter
                return
            }

            Print-Step "Creating backup..."
            & $migrateBin -mode backup -src $srcDb 2>&1 | ForEach-Object { Write-Host $_ }

            if ($LASTEXITCODE -eq 0) {
                Print-Success "Backup created successfully!"
            } else {
                Print-Error "Backup failed."
            }
        }
        "0" { return }
        default {
            Print-Warning "Invalid option"
        }
    }

    Press-Enter
}

#===============================================================================
# Main Menu
#===============================================================================

function Show-Menu {
    Print-Header
    Print-Status
    
    Write-Host "========== MAIN MENU ==========" -ForegroundColor White
    Write-Host ""
    Write-Host "  1. FRESH INSTALLATION"
    Write-Host "  2. UPDATE"
    Write-Host "  3. REPAIR INSTALLATION"
    Write-Host "  4. INSTALLATION VALIDATION"
    Write-Host "  5. Backup"
    Write-Host "  6. Reset admin password"
    Write-Host "  7. Build & deploy server"
    Write-Host "  8. DIAGNOSTICS"
    Write-Host "  9. UNINSTALL"
    Write-Host ""
    Write-Host "  L. MINIMAL INSTALLATION (server only)"
    Write-Host "  C. Configure SSL certificates"
    Write-Host "  T. Toggle HTTP/HTTPS mode"
    Write-Host "  M. Database migration"
    Write-Host "  S. Settings (paths)"
    Write-Host "  0. Exit"
    Write-Host ""
}

function Main {
    # Auto-detect paths on startup
    Write-Host "Detecting installation..." -ForegroundColor Cyan
    Auto-DetectPaths
    Write-Host ""
    Start-Sleep -Seconds 1
    
    # Auto mode - run installation directly
    if ($script:AUTO_MODE) {
        Print-Info "Running in AUTO mode..."
        if ($script:MINIMAL_MODE) {
            Do-InstallMinimal
        } else {
            Do-Install
        }
        exit 0
    }
    
    while ($true) {
        $menuLabels = @(
            "Fresh installation`tFull install from scratch",
            "Update`tUpdate an existing installation",
            "Repair installation`tFix common problems",
            "Validate installation`tCheck correctness",
            "Backup`tCreate a backup",
            "Reset admin password`tReset the console admin",
            "Build & deploy server`tCompile and deploy the Go server",
            "Diagnostics`tDetailed problem analysis",
            "Uninstall`tRemove BetterDesk",
            "Minimal installation`tServer only",
            "Configure SSL certificates`tLet's Encrypt / custom / self-signed",
            "Toggle HTTP/HTTPS`tSwitch protocol mode",
            "Database migration`tMigrate between backends",
            "Settings (paths)`tConfigure install paths",
            "Exit`tQuit the manager"
        )
        $menuActions = @("1", "2", "3", "4", "5", "6", "7", "8", "9", "L", "C", "T", "M", "S", "0")

        $choice = ""
        if (Test-TuiAvailable) {
            $statusLine = "BetterDesk Console Manager v$VERSION"
            if (Invoke-TuiSelect -Title "BetterDesk Console Manager v$VERSION" -Subtitle "Use arrow keys, Enter to select" -Items $menuLabels) {
                $choice = $menuActions[$script:TUI_RESULT]
            } else {
                $choice = "0"
            }
        } else {
            Show-Menu
            $choice = Read-Host "Select option"
        }
        
        switch ($choice) {
            "1" { Do-Install }
            "2" { Do-Update }
            "3" { Do-Repair }
            "4" { Do-Validate }
            "5" { Do-Backup }
            "6" { Do-ResetPassword }
            "7" { Do-Build }
            "8" { Do-Diagnostics }
            "9" { Do-Uninstall }
            "L" { Do-InstallMinimal }
            "l" { Do-InstallMinimal }
            "C" { Do-ConfigureSSL }
            "c" { Do-ConfigureSSL }
            "T" { Do-ToggleProtocol }
            "t" { Do-ToggleProtocol }
            "M" { Do-MigrateDatabase }
            "m" { Do-MigrateDatabase }
            "S" { Configure-Paths }
            "s" { Configure-Paths }
            "0" {
                Write-Host ""
                Print-Info "Goodbye!"
                exit 0
            }
            default {
                Print-Warning "Invalid option"
                Start-Sleep -Seconds 1
            }
        }
    }
}

# Run
Main
