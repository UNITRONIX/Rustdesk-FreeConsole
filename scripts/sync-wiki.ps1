# Sync docs/wiki/ to GitHub Wiki (BetterDesk.wiki.git)
param(
    [string]$CommitMessage = "Sync wiki from docs/wiki/",
    [string]$WikiRepo = "https://github.com/UNITRONIX/BetterDesk.wiki.git",
    [string]$WikiDir = "$env:TEMP\BetterDesk-wiki-sync"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
$WikiSrc = Join-Path $RepoRoot "docs\wiki"

if (-not (Test-Path $WikiSrc)) {
    Write-Error "wiki source not found: $WikiSrc"
}

if (-not (Test-Path (Join-Path $WikiDir ".git"))) {
    git clone $WikiRepo $WikiDir
} else {
    Push-Location $WikiDir
    git pull --rebase origin master
    Pop-Location
}

Get-ChildItem $WikiDir -Exclude .git | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $WikiSrc "*") -Destination $WikiDir -Recurse -Force

Push-Location $WikiDir
git add -A
$status = git status --porcelain
if (-not $status) {
    Write-Host "wiki already up to date"
    Pop-Location
    exit 0
}
git commit -m $CommitMessage
git push origin master
Pop-Location
Write-Host "wiki pushed to $WikiRepo"
