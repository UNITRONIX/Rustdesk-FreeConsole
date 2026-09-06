# Soft check for Windows (PowerShell)
# Usage: powershell -File scripts/check-wiki-staleness.ps1
$ErrorActionPreference = 'Stop'
$wiki = Join-Path $PSScriptRoot '..\docs\wiki'
$fail = $false
$patterns = @(
  '3\.3\.132',
  'v2\.4\.0',
  'mac_address',
  'Node\.js Client API',
  '/api/login/2fa',
  'Node\.js 18\+',
  'badge/Node\.js-18'
)
Get-ChildItem $wiki -Filter '*.md' | ForEach-Object {
  $file = $_.Name
  $n = 0
  Get-Content $_.FullName | ForEach-Object {
    $n++
    $t = $_
    foreach ($p in $patterns) {
      if ($t -match $p) {
        if ($t -match 'not.?`?mac_address' -or $t -match 'no separate' -or $t -match '\*\*no\*\* separate') {
          continue
        }
        Write-Host "FAIL ${file}:${n}: $t"
        $script:fail = $true
      }
    }
  }
}
if ($fail) { exit 1 }
Write-Host 'OK: wiki stale-claim checks passed'
