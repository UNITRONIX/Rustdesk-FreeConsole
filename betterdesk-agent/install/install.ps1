# BetterDesk Agent — Windows installer (NSSM service)
# Usage: Run as Administrator
#   .\install.ps1 [-Server URL] [-Key KEY] [-Name NAME] [-Uninstall] [-Purge]
[CmdletBinding()]
param(
    [string]$Server,
    [string]$Key,
    [string]$Name,
    [string]$InstallDir = "$env:ProgramFiles\BetterDesk\Agent",
    [switch]$Uninstall,
    [switch]$Purge
)

$ErrorActionPreference = "Stop"
$ServiceName = "BetterDeskAgent"
$NSSMUrl = "https://nssm.cc/release/nssm-2.24.zip"

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Host "ERROR: Run this script as Administrator" -ForegroundColor Red
    exit 1
}

# Uninstall
if ($Uninstall) {
    Write-Host "=== Uninstalling BetterDesk Agent ===" -ForegroundColor Yellow
    $nssmPath = "$InstallDir\nssm.exe"
    if (Test-Path $nssmPath) {
        & $nssmPath stop $ServiceName 2>$null
        & $nssmPath remove $ServiceName confirm 2>$null
    } elseif (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        sc.exe delete $ServiceName 2>$null
    }
    Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false -ErrorAction SilentlyContinue
    if ($Purge) {
        if (Test-Path $InstallDir) {
            Remove-Item -Path $InstallDir -Recurse -Force
        }
        Write-Host "BetterDesk Agent uninstalled and data purged." -ForegroundColor Green
    } else {
        Remove-Item -Path "$InstallDir\betterdesk-agent.exe" -Force -ErrorAction SilentlyContinue
        Write-Host "BetterDesk Agent uninstalled; config and data preserved at $InstallDir." -ForegroundColor Green
    }
    exit 0
}

# Find binary
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinaryPath = $null
$Candidates = @(
    (Join-Path (Split-Path $ScriptDir) "betterdesk-agent.exe"),
    (Join-Path $ScriptDir "betterdesk-agent.exe")
)
foreach ($c in $Candidates) {
    if (Test-Path $c) { $BinaryPath = $c; break }
}
if (-not $BinaryPath) {
    Write-Host "ERROR: betterdesk-agent.exe not found. Build it first." -ForegroundColor Red
    exit 1
}

Write-Host "=== Installing BetterDesk Agent ===" -ForegroundColor Cyan

# Create directories
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
New-Item -ItemType Directory -Path "$InstallDir\data" -Force | Out-Null

# Copy binary
Copy-Item -Path $BinaryPath -Destination "$InstallDir\betterdesk-agent.exe" -Force

# Create config if not exists
$ConfigFile = "$InstallDir\config.json"
if (-not (Test-Path $ConfigFile)) {
    if (-not $Server) {
        $Server = Read-Host "Gateway WebSocket URL (ws://host:21122/cdap)"
    }
    if (-not $Key) {
        $Key = Read-Host "API Key"
    }
    if (-not $Name) {
        $Name = $env:COMPUTERNAME
    }
    if ($Server -notmatch '^(ws|wss)://') {
        throw "Gateway URL must start with ws:// or wss://"
    }
    if (-not $Key) {
        throw "API key must not be empty"
    }
    $config = @{
        server       = $Server
        auth_method  = "api_key"
        api_key      = $Key
        device_name  = $Name
        device_type  = "os_agent"
        terminal     = $true
        file_browser = $true
        clipboard    = $true
        screenshot   = $true
        file_root    = "C:\"
        heartbeat_sec = 15
        reconnect_sec = 5
        max_reconnect = 300
        log_level    = "info"
        data_dir     = "$InstallDir\data"
    }
    $config | ConvertTo-Json -Depth 5 | Set-Content -Path $ConfigFile -Encoding UTF8
    Write-Host "Config created: $ConfigFile"
} else {
    Write-Host "Config exists, preserving: $ConfigFile"
}

# Install NSSM if not present
$nssmPath = "$InstallDir\nssm.exe"
$serviceMode = "nssm"
if (-not (Test-Path $nssmPath)) {
    Write-Host "Downloading NSSM..."
    try {
        $zipPath = "$env:TEMP\nssm.zip"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $NSSMUrl -OutFile $zipPath -UseBasicParsing
        $extractDir = "$env:TEMP\nssm-extract"
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
        $nssmBin = Get-ChildItem -Path $extractDir -Recurse -Filter "nssm.exe" |
            Where-Object { $_.DirectoryName -like "*win64*" } | Select-Object -First 1
        if ($nssmBin) {
            Copy-Item -Path $nssmBin.FullName -Destination $nssmPath -Force
        } else {
            throw "nssm.exe was not found in the archive"
        }
        Remove-Item $zipPath, $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Warning "NSSM installation failed: $($_.Exception.Message)"
        Write-Warning "Falling back to a per-user scheduled task."
        $serviceMode = "scheduled-task"
    }
}

if ($serviceMode -eq "nssm" -and (Test-Path $nssmPath)) {
    # Create NSSM service
    & $nssmPath stop $ServiceName 2>$null
    & $nssmPath remove $ServiceName confirm 2>$null
    Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false -ErrorAction SilentlyContinue

    & $nssmPath install $ServiceName "$InstallDir\betterdesk-agent.exe"
    & $nssmPath set $ServiceName AppParameters "-config `"$ConfigFile`""
    & $nssmPath set $ServiceName AppDirectory $InstallDir
    & $nssmPath set $ServiceName Start SERVICE_AUTO_START
    & $nssmPath set $ServiceName AppStdout "$InstallDir\data\agent.log"
    & $nssmPath set $ServiceName AppStderr "$InstallDir\data\agent.log"
    & $nssmPath set $ServiceName AppRotateFiles 1
    & $nssmPath set $ServiceName AppRotateBytes 10485760
    & $nssmPath set $ServiceName Description "BetterDesk CDAP Agent"

    & $nssmPath start $ServiceName
    if ($LASTEXITCODE -ne 0) {
        throw "NSSM failed to start $ServiceName (exit code $LASTEXITCODE)"
    }
    Start-Sleep -Seconds 2
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $service -or $service.Status -ne "Running") {
        throw "$ServiceName was installed but is not running"
    }
} else {
    # NSSM is optional: keep the installer usable on restricted hosts.
    $taskAction = New-ScheduledTaskAction `
        -Execute "$InstallDir\betterdesk-agent.exe" `
        -Argument "-config `"$ConfigFile`"" `
        -WorkingDirectory $InstallDir
    $taskTrigger = New-ScheduledTaskTrigger -AtLogOn
    $taskPrincipal = New-ScheduledTaskPrincipal `
        -UserId "$env:USERDOMAIN\$env:USERNAME" `
        -LogonType Interactive `
        -RunLevel Limited
    Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $ServiceName -Action $taskAction `
        -Trigger $taskTrigger -Principal $taskPrincipal -Force | Out-Null
    Start-ScheduledTask -TaskName $ServiceName
    if (-not (Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue)) {
        throw "Scheduled-task fallback was not registered"
    }
}

Write-Host ""
Write-Host "=== BetterDesk Agent Installed ===" -ForegroundColor Green
Write-Host "  Binary:  $InstallDir\betterdesk-agent.exe"
Write-Host "  Config:  $ConfigFile"
Write-Host "  Autostart: $ServiceName ($serviceMode)"
Write-Host ""
Write-Host "Commands:"
Write-Host "  nssm status $ServiceName"
Write-Host "  nssm restart $ServiceName"
Write-Host "  Get-Content $InstallDir\data\agent.log -Tail 50"
