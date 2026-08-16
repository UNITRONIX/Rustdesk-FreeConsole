#Requires -RunAsAdministrator
<#
.SYNOPSIS
  One-time Admin fix: install BetterDeskServiceControl watcher and deploy a pending Go binary.

.DESCRIPTION
  Panel updates run as NT SERVICE\BetterDeskConsole and cannot stop/kill BetterDeskServer.
  Stopping BetterDeskConsole mid-Apply would abort the update itself.

  This script (run elevated once):
    1. Registers LocalSystem NSSM service BetterDeskServiceControl (--watch-loop)
    2. Stops BetterDeskServer
    3. Deploys pending binary from data\service-control\pending-server-deploy.json (if present)
    4. Starts BetterDeskServer (+ watcher)

  After this, Settings → Updates can stop/deploy via the watcher without Admin.
#>
$ErrorActionPreference = 'Stop'

function Find-ConsoleRoot {
    $here = $PSScriptRoot
    if ($here -and (Test-Path (Join-Path $here 'windows-service-control.js'))) {
        return (Split-Path $here -Parent)
    }
    foreach ($c in @(
        $env:CONSOLE_PATH,
        'C:\BetterDeskConsole',
        'C:\betterdesk-console',
        'C:\Program Files\BetterDeskConsole'
    )) {
        if ($c -and (Test-Path (Join-Path $c 'server.js'))) { return $c }
    }
    throw 'Could not locate BetterDesk console root (set CONSOLE_PATH)'
}

$consoleRoot = Find-ConsoleRoot
$helper = Join-Path $consoleRoot 'scripts\windows-service-control.js'
$watchDir = Join-Path $consoleRoot 'data\service-control'
$pendingPath = Join-Path $watchDir 'pending-server-deploy.json'
$logs = Join-Path $consoleRoot 'logs'
New-Item -ItemType Directory -Path $watchDir -Force | Out-Null
New-Item -ItemType Directory -Path $logs -Force | Out-Null

if (-not (Test-Path $helper)) {
    throw "Missing $helper — run panel Update first so scripts are on disk"
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'node.exe' }

$nssmCmd = Get-Command nssm -ErrorAction SilentlyContinue
$nssm = if ($nssmCmd) { $nssmCmd.Source } else {
    $local = Join-Path (Split-Path $consoleRoot -Parent) 'tools\nssm.exe'
    if (Test-Path $local) { $local } else { $null }
}

$svcName = 'BetterDeskServiceControl'
Write-Host "Console root: $consoleRoot"

if ($nssm) {
    if (-not (Get-Service -Name $svcName -ErrorAction SilentlyContinue)) {
        & $nssm install $svcName $node | Out-Null
    }
    $appParams = "`"$helper`" --watch-loop `"$watchDir`""
    & $nssm set $svcName AppParameters $appParams | Out-Null
    & $nssm set $svcName AppDirectory $consoleRoot | Out-Null
    & $nssm set $svcName DisplayName 'BetterDesk Service Control' | Out-Null
    & $nssm set $svcName Start SERVICE_AUTO_START | Out-Null
    & $nssm set $svcName ObjectName LocalSystem | Out-Null
    & $nssm set $svcName AppStdout (Join-Path $logs 'service-control.log') | Out-Null
    & $nssm set $svcName AppStderr (Join-Path $logs 'service-control_error.log') | Out-Null
    & $nssm set $svcName AppExit Default Restart | Out-Null
    try { & icacls $watchDir /grant 'NT SERVICE\BetterDeskConsole:(OI)(CI)M' /T /C /Q | Out-Null } catch {}
    Start-Service -Name $svcName -ErrorAction SilentlyContinue
    & $nssm start $svcName 2>$null | Out-Null
    Write-Host "OK: $svcName watcher installed/started"
} else {
    Write-Warning 'nssm not found — registering legacy scheduled task only'
    $tr = "`"$node`" `"$helper`" --watch-dir `"$watchDir`""
    & schtasks /Create /TN $svcName /TR $tr /SC ONCE /ST 23:59 /SD 01/01/2099 /RU SYSTEM /RL HIGHEST /F | Out-Null
}

# Grant console SCM rights on BetterDeskServer
try {
    $sid = (New-Object System.Security.Principal.NTAccount('NT SERVICE\BetterDeskConsole')).Translate(
        [System.Security.Principal.SecurityIdentifier]
    ).Value
    $sd = (& sc.exe sdshow BetterDeskServer 2>$null | Out-String).Trim()
    if ($sd -and $sd -notmatch [regex]::Escape($sid)) {
        $ace = "(A;;RPWPLCCCRC;;;$sid)"
        if ($sd -match '^(D:)') { $newSd = $sd -replace '^(D:)', "`$1$ace" } else { $newSd = "D:$ace$sd" }
        & sc.exe sdset BetterDeskServer $newSd | Out-Null
        Write-Host 'OK: granted BetterDeskConsole start/stop on BetterDeskServer'
    }
} catch {
    Write-Warning "SCM grant skipped: $($_.Exception.Message)"
}

$source = $null
$target = $null
if (Test-Path $pendingPath) {
    $pending = Get-Content $pendingPath -Raw | ConvertFrom-Json
    $source = [string]$pending.source
    $target = [string]$pending.target
}

Write-Host 'Stopping BetterDeskServer...'
& nssm stop BetterDeskServer 2>$null | Out-Null
Start-Sleep -Seconds 2
& sc.exe stop BetterDeskServer 2>$null | Out-Null
Get-Process betterdesk-server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

if ($source -and $target -and (Test-Path $source)) {
    Write-Host "Deploying $source -> $target"
    $dir = Split-Path $target -Parent
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    if (Test-Path $target) {
        Copy-Item $target "$target.bak.$(Get-Date -Format yyyyMMddHHmmss)" -Force
        Rename-Item $target "$target.old.$(Get-Date -Format yyyyMMddHHmmss)" -ErrorAction SilentlyContinue
    }
    Copy-Item $source $target -Force
    Remove-Item $pendingPath -Force -ErrorAction SilentlyContinue
    Write-Host 'OK: Go binary deployed'
} else {
    Write-Host 'No pending-server-deploy.json (watcher install only)'
}

Write-Host 'Starting BetterDeskServer...'
& nssm start BetterDeskServer 2>$null | Out-Null
Start-Service BetterDeskServer -ErrorAction SilentlyContinue
Write-Host 'Done. Re-open Settings → Updates if you still need to Apply console commits.'
