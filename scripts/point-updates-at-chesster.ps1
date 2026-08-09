# One-time: point BetterDesk console Updates at Chesster1981/BetterDesk (dev).
# Run on the panel host with rights to edit the console .env and restart services.
#
# Usage:
#   .\scripts\point-updates-at-chesster.ps1
#   .\scripts\point-updates-at-chesster.ps1 -EnvPath 'C:\BetterDeskConsole\.env'

[CmdletBinding()]
param(
    [string]$EnvPath = ''
)

$ErrorActionPreference = 'Stop'

function Upsert-EnvKey([string]$text, [string]$key, [string]$value) {
    $line = "$key=$value"
    if ($text -match "(?m)^$([regex]::Escape($key))=") {
        return [regex]::Replace($text, "(?m)^$([regex]::Escape($key))=.*$", $line)
    }
    if ([string]::IsNullOrWhiteSpace($text)) {
        return "$line`r`n"
    }
    return ($text.TrimEnd() + "`r`n" + $line + "`r`n")
}

if (-not $EnvPath) {
    $candidates = @(
        'C:\BetterDeskConsole\.env',
        'C:\BetterDesk\web-nodejs\.env',
        'C:\Program Files\BetterDesk\web-nodejs\.env'
    )
    $EnvPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $EnvPath -or -not (Test-Path $EnvPath)) {
    throw "Console .env not found. Pass -EnvPath to the console .env file."
}

Write-Host "Using $EnvPath"
$raw = Get-Content -Raw -Path $EnvPath
$raw = Upsert-EnvKey $raw 'UPDATE_GITHUB_OWNER' 'Chesster1981'
$raw = Upsert-EnvKey $raw 'UPDATE_GITHUB_REPO' 'BetterDesk'
$raw = Upsert-EnvKey $raw 'UPDATE_GITHUB_BRANCH' 'dev'
Set-Content -Path $EnvPath -Value $raw -Encoding utf8

Write-Host 'Set UPDATE_GITHUB_OWNER=Chesster1981, REPO=BetterDesk, BRANCH=dev'
Write-Host 'Restart the console, then Settings → Updates → Check / Install (include Go server).'

if (Get-Command nssm -ErrorAction SilentlyContinue) {
    foreach ($svc in @('BetterDeskConsole', 'BetterDeskServer')) {
        & nssm restart $svc 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Restarted $svc"
        }
    }
}
